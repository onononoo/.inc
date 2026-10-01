import type { QuickPickItem } from '../contracts/commands';
import { Store } from './store';

/** Results beyond this many are not rendered; the surface says how many were left out. */
export const MAX_RESULTS = 200;
/** An async query that is still running after this long shows a loading line (avoids flicker). */
export const LOADING_DELAY_MS = 150;

/** A pick item plus the highlight data that only the built-in palette modes produce. */
export interface QuickItem<T = unknown> extends QuickPickItem<T> {
  /** Indexes into `description` to highlight (file paths in quick open). */
  descriptionHighlights?: number[];
}

/** Handed to a query so it can stop early once a newer value has been typed. */
export interface QueryToken {
  readonly stale: boolean;
}

export interface QueryResult {
  items: readonly QuickItem[];
  /** Number of matches before the list was cut; defaults to `items.length`. */
  total?: number;
  /** Neutral progress text under the field, for example while the file index builds. */
  status?: string;
  /** Validation or failure text under the field. */
  message?: { tone: 'error' | 'info'; text: string };
  /** Shown instead of the list when there are no items and no message explains why. */
  emptyText?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** Item to make active; defaults to the first one. */
  activeId?: string;
}

export interface SessionSpec {
  kind: 'pick' | 'input';
  /** A second `open` with the same key reuses the visible surface instead of replacing it. */
  reuseKey?: string;
  title?: string;
  placeholder: string;
  ariaLabel: string;
  initialValue: string;
  emptyText: string;
  prompt?: string;
  password?: boolean;
  /** Items to mark as the current choice. */
  currentIds?: readonly string[];
  /** Pick sessions: the items for the text typed so far. Called once on open and on every edit. */
  query?(value: string, token: QueryToken): QueryResult | Promise<QueryResult>;
  /** Input sessions: an error message to block submission, or undefined when the value is fine. */
  validate?(value: string, token: QueryToken): string | undefined | Promise<string | undefined>;
  /** Pick sessions: called when the highlighted row changes (arrow keys, filtering). */
  onActive?(item: QuickItem | undefined): void;
  /** Called after the surface has closed and focus has been handed back. */
  accept(item: QuickItem | undefined, value: string): void | Promise<void>;
  cancel?(): void;
  /** Runs while the session is open; `refresh` re-runs the query. Returns the cleanup. */
  attach?(handle: { refresh(): void }): () => void;
}

export interface QuickInputView {
  visible: boolean;
  sessionId: number;
  /** Changes when the field should take keyboard focus again (a reused session). */
  focusNonce: number;
  kind: 'pick' | 'input';
  title: string | undefined;
  ariaLabel: string;
  placeholder: string;
  value: string;
  prompt: string | undefined;
  password: boolean;
  items: readonly QuickItem[];
  total: number;
  activeIndex: number;
  currentIds: ReadonlySet<string>;
  loading: boolean;
  status: string | undefined;
  message: { tone: 'error' | 'info'; text: string } | undefined;
  emptyText: string;
}

export interface ControllerDeps {
  /** Remember what has focus; the returned function puts it back. */
  captureFocus?(): (() => void) | undefined;
  onVisibleChange?(visible: boolean): void;
  /** A handler or provider failed; show it to the person. */
  reportError?(error: unknown): void;
}

type Move = { by: number; wrap?: boolean } | { to: 'first' | 'last' };

interface Running {
  id: number;
  spec: SessionSpec;
  value: string;
  /** Bumped by every edit and by closing; a token is stale once this moves on. */
  seq: number;
  restore: (() => void) | undefined;
  detach: (() => void) | undefined;
  pendingAccept: boolean;
  inflight: boolean;
  loadingTimer: ReturnType<typeof setTimeout> | undefined;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

function hiddenView(sessionId: number, focusNonce: number): QuickInputView {
  return {
    visible: false,
    sessionId,
    focusNonce,
    kind: 'pick',
    title: undefined,
    ariaLabel: '',
    placeholder: '',
    value: '',
    prompt: undefined,
    password: false,
    items: [],
    total: 0,
    activeIndex: -1,
    currentIds: EMPTY_IDS,
    loading: false,
    status: undefined,
    message: undefined,
    emptyText: '',
  };
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/**
 * The state machine behind the quick input surface (command palette, quick open, go to line and
 * generic pickers). It knows nothing about the DOM: the React host renders `view` and forwards
 * keystrokes, which keeps every rule here unit testable.
 *
 * One session is open at a time. Opening another replaces it (the old one is cancelled) and the
 * element that had focus before the first session is the one that gets it back.
 */
export class QuickInputController {
  private deps: ControllerDeps;
  private running: Running | null = null;
  private nextId = 1;
  private nonce = 0;
  private readonly store = new Store<QuickInputView>(hiddenView(0, 0));

  constructor(deps: ControllerDeps = {}) {
    this.deps = deps;
  }

  configure(deps: ControllerDeps): void {
    this.deps = { ...this.deps, ...deps };
  }

  readonly getView = (): QuickInputView => this.store.get();
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  isOpen(): boolean {
    return this.running !== null;
  }

  /** Show a session. Resolves nothing itself: results go through `spec.accept` and `spec.cancel`. */
  open(spec: SessionSpec): void {
    const previous = this.running;
    if (previous && spec.reuseKey !== undefined && previous.spec.reuseKey === spec.reuseKey) {
      this.reuse(previous, spec);
      return;
    }

    let restore: (() => void) | undefined;
    if (previous) {
      restore = previous.restore;
      this.release(previous);
      this.safely(() => previous.spec.cancel?.());
    } else {
      restore = this.deps.captureFocus?.();
    }

    const running: Running = {
      id: this.nextId++,
      spec,
      value: spec.initialValue,
      seq: 0,
      restore,
      detach: undefined,
      pendingAccept: false,
      inflight: false,
      loadingTimer: undefined,
    };
    this.running = running;
    this.store.set({
      ...hiddenView(running.id, ++this.nonce),
      visible: true,
      kind: spec.kind,
      title: spec.title,
      ariaLabel: spec.ariaLabel,
      placeholder: spec.placeholder,
      value: spec.initialValue,
      prompt: spec.prompt,
      password: spec.password ?? false,
      currentIds: spec.currentIds ? new Set(spec.currentIds) : EMPTY_IDS,
      emptyText: spec.emptyText,
    });
    if (!previous) this.deps.onVisibleChange?.(true);

    if (spec.attach) {
      running.detach = spec.attach({ refresh: () => this.refresh(running) });
    }
    if (spec.kind === 'pick') this.runQuery(running, false);
  }

  private reuse(running: Running, spec: SessionSpec): void {
    running.detach?.();
    running.spec = spec;
    running.value = spec.initialValue;
    running.seq++;
    running.pendingAccept = false;
    running.detach = spec.attach?.({ refresh: () => this.refresh(running) });
    this.patch({
      value: spec.initialValue,
      focusNonce: ++this.nonce,
      currentIds: spec.currentIds ? new Set(spec.currentIds) : EMPTY_IDS,
    });
    this.runQuery(running, false);
  }

  /** The person edited the field. */
  setValue(value: string): void {
    const running = this.running;
    if (!running || value === running.value) return;
    running.value = value;
    running.seq++;
    running.pendingAccept = false;
    this.patch({ value });
    if (running.spec.kind === 'pick') this.runQuery(running, false);
    else this.runValidate(running);
  }

  /** Move the active row. Arrow keys wrap; paging and Home/End clamp. */
  move(move: Move): void {
    const view = this.store.get();
    const count = view.items.length;
    if (!view.visible || count === 0) return;
    let next: number;
    if ('to' in move) {
      next = move.to === 'first' ? 0 : count - 1;
    } else {
      const base = view.activeIndex < 0 ? (move.by > 0 ? -1 : count) : view.activeIndex;
      next = base + move.by;
      if (move.wrap === false) next = Math.min(count - 1, Math.max(0, next));
      else next = ((next % count) + count) % count;
    }
    if (next !== view.activeIndex) {
      this.patch({ activeIndex: next });
      this.notifyActive();
    }
  }

  private notifyActive(): void {
    const view = this.store.get();
    const item = view.items[view.activeIndex];
    this.safely(() => this.running?.spec.onActive?.(item));
  }

  /** Pointer or keyboard: choose the row at `index`, or the active row. */
  accept(index?: number): void {
    const running = this.running;
    if (!running) return;
    if (running.spec.kind === 'input') {
      void this.submitInput(running);
      return;
    }
    const view = this.store.get();
    const item = view.items[index ?? view.activeIndex];
    if (!item) {
      // A query is still on its way; accept its first result instead of dropping the key press.
      if (running.inflight) running.pendingAccept = true;
      return;
    }
    if (running.inflight && index === undefined) {
      running.pendingAccept = true;
      return;
    }
    this.close(running, true);
    this.safely(() => running.spec.accept(item, running.value));
  }

  /** Escape, or a click outside. `restoreFocus` is false when the click is moving focus itself. */
  cancel(options: { restoreFocus?: boolean } = {}): void {
    const running = this.running;
    if (!running) return;
    this.close(running, options.restoreFocus ?? true);
    this.safely(() => running.spec.cancel?.());
  }

  private close(running: Running, restoreFocus: boolean): void {
    if (this.running !== running) return;
    this.release(running);
    this.running = null;
    this.store.set(hiddenView(running.id, this.nonce));
    this.deps.onVisibleChange?.(false);
    if (restoreFocus) this.safely(() => running.restore?.());
  }

  /** Stop everything the session had going without touching the view. */
  private release(running: Running): void {
    running.seq++;
    running.inflight = false;
    if (running.loadingTimer !== undefined) clearTimeout(running.loadingTimer);
    running.loadingTimer = undefined;
    running.detach?.();
    running.detach = undefined;
  }

  private refresh(running: Running): void {
    if (this.running !== running || running.spec.kind !== 'pick') return;
    this.runQuery(running, true);
  }

  private token(running: Running): QueryToken {
    const seq = running.seq;
    return {
      get stale() {
        return running.seq !== seq;
      },
    };
  }

  private runQuery(running: Running, preserveActive: boolean): void {
    const { spec } = running;
    if (!spec.query) return;
    running.seq++;
    const token = this.token(running);
    const previousId = preserveActive
      ? this.store.get().items[this.store.get().activeIndex]?.id
      : undefined;
    if (running.loadingTimer !== undefined) clearTimeout(running.loadingTimer);
    running.loadingTimer = undefined;

    let outcome: QueryResult | Promise<QueryResult>;
    try {
      outcome = spec.query(running.value, token);
    } catch (error) {
      running.inflight = false;
      this.applyFailure(running, error);
      return;
    }

    if (!isPromise(outcome)) {
      running.inflight = false;
      this.applyResult(running, outcome, previousId);
      return;
    }

    running.inflight = true;
    running.loadingTimer = setTimeout(() => {
      running.loadingTimer = undefined;
      if (!token.stale && this.running === running) this.patch({ loading: true });
    }, LOADING_DELAY_MS);
    outcome.then(
      (result) => {
        if (token.stale || this.running !== running) return;
        this.settle(running);
        this.applyResult(running, result, previousId);
      },
      (error: unknown) => {
        if (token.stale || this.running !== running) return;
        this.settle(running);
        this.applyFailure(running, error);
      },
    );
  }

  private settle(running: Running): void {
    running.inflight = false;
    if (running.loadingTimer !== undefined) clearTimeout(running.loadingTimer);
    running.loadingTimer = undefined;
  }

  private applyResult(running: Running, result: QueryResult, previousId: string | undefined): void {
    const items =
      result.items.length > MAX_RESULTS ? result.items.slice(0, MAX_RESULTS) : result.items;
    const wanted = previousId ?? result.activeId;
    let activeIndex = items.length === 0 ? -1 : 0;
    if (wanted !== undefined) {
      const found = items.findIndex((item) => item.id === wanted);
      if (found !== -1) activeIndex = found;
    }
    this.patch({
      items,
      total: Math.max(result.total ?? result.items.length, items.length),
      activeIndex,
      loading: false,
      status: result.status,
      message: result.message,
      emptyText: result.emptyText ?? running.spec.emptyText,
      placeholder: result.placeholder ?? running.spec.placeholder,
      ariaLabel: result.ariaLabel ?? running.spec.ariaLabel,
    });
    this.notifyActive();
    if (running.pendingAccept && items.length > 0) {
      running.pendingAccept = false;
      this.accept();
    } else if (!running.inflight) {
      running.pendingAccept = false;
    }
  }

  private applyFailure(running: Running, error: unknown): void {
    running.pendingAccept = false;
    this.safely(() => this.deps.reportError?.(error));
    this.patch({
      items: [],
      total: 0,
      activeIndex: -1,
      loading: false,
      status: undefined,
      message: { tone: 'error', text: errorText(error) },
    });
  }

  private runValidate(running: Running): void {
    const { spec } = running;
    if (!spec.validate) return;
    const token = this.token(running);
    let outcome: string | undefined | Promise<string | undefined>;
    try {
      outcome = spec.validate(running.value, token);
    } catch (error) {
      this.patch({ message: { tone: 'error', text: errorText(error) } });
      return;
    }
    const show = (text: string | undefined) => {
      if (token.stale || this.running !== running) return;
      this.patch({ message: text ? { tone: 'error', text } : undefined });
    };
    if (isPromise(outcome)) {
      outcome.then(show, (error: unknown) => show(errorText(error)));
    } else {
      show(outcome);
    }
  }

  private async submitInput(running: Running): Promise<void> {
    const token = this.token(running);
    let problem: string | undefined;
    try {
      problem = await running.spec.validate?.(running.value, token);
    } catch (error) {
      problem = errorText(error);
    }
    if (token.stale || this.running !== running) return;
    if (problem) {
      this.patch({ message: { tone: 'error', text: problem } });
      return;
    }
    this.close(running, true);
    this.safely(() => running.spec.accept(undefined, running.value));
  }

  private patch(change: Partial<QuickInputView>): void {
    this.store.set({ ...this.store.get(), ...change });
  }

  private safely(fn: () => void | Promise<void>): void {
    const report = (error: unknown) => {
      try {
        this.deps.reportError?.(error);
      } catch {
        // Reporting must never take the surface down with it.
      }
    };
    try {
      const out = fn();
      if (isPromise(out)) out.catch(report);
    } catch (error) {
      report(error);
    }
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' && error ? error : 'Something went wrong.';
}
