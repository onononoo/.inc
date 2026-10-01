import type { KeybindingOverride } from '@shared/api/settings';
import { COMMANDS } from '@shared/commands/catalog';
import type { CommandDef } from '@shared/commands/types';
import type { Platform } from '@shared/paths';
import { isValidWhen } from '@shared/when';
import type {
  CommandService,
  ContextKeyService,
  KeybindingService,
  ResolvedKeybinding,
  Unsubscribe,
} from '../contracts/commands';
import {
  canonicalChord,
  chordLabel,
  eventMatchesStroke,
  isAltGraph,
  isModifierOnly,
  keyCandidates,
  parseChord,
  strokeFromEvent,
  strokesEqual,
  strokeToLabel,
  type Chord,
  type KeyEventLike,
  type Stroke,
} from './keys';

export const CHORD_TIMEOUT_MS = 1500;

/** A keydown as the service sees it: the key data plus the DOM methods it needs to consume it. */
export type KeyDownLike = KeyEventLike & {
  preventDefault(): void;
  stopPropagation(): void;
  target?: unknown;
};

/** The subset of `window` the service listens on. */
export interface KeyEventTarget {
  addEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
  removeEventListener(type: string, listener: (event: never) => void, capture?: boolean): void;
}

/** Enough of a keydown to send it again to an element (used to hand chords back to Monaco). */
export interface ReplayableKey {
  key: string;
  code: string;
  keyCode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface KeybindingServiceDeps {
  platform: Platform;
  contexts: ContextKeyService;
  commands: Pick<CommandService, 'execute' | 'isEnabled'>;
  /** Defaults to the shipped catalog. */
  catalog?: readonly CommandDef[];
  loadOverrides(): Promise<KeybindingOverride[]>;
  onOverridesChanged(cb: (entries: KeybindingOverride[]) => void): Unsubscribe;
  target: KeyEventTarget;
  /** Text to show while a chord is pending; null clears it. */
  onHint?(text: string | null): void;
  /** True when the element belongs to a Monaco editor, which has chords of its own. */
  isEditorTarget?(target: unknown): boolean;
  /** Dispatch a keydown to an element so its own handlers see it. */
  replayKey?(target: unknown, key: ReplayableKey): void;
  chordTimeoutMs?: number;
}

export interface KeybindingServiceImpl extends KeybindingService {
  /** Handle one keydown; true when a binding consumed it. Exposed for tests. */
  handleKeyDown(e: KeyDownLike): boolean;
  /** Replace the user overrides (what `keybindings:get` returned). */
  setOverrides(entries: readonly KeybindingOverride[]): void;
  /** Drop a half-typed chord. */
  cancelChord(): void;
}

interface Binding {
  commandId: string;
  chord: Chord;
  canonical: string;
  when?: string;
  source: 'default' | 'user';
  args?: unknown;
  /** Definition order; later wins among equals. */
  order: number;
}

interface Pending {
  first: Stroke;
  key: ReplayableKey;
  target: unknown;
  timer: ReturnType<typeof setTimeout>;
}

/** User bindings beat defaults; a binding with a when clause beats an unconditional one; later beats earlier. */
function rank(b: Binding): number {
  return (b.source === 'user' ? 2_000_000 : 0) + (b.when ? 1_000_000 : 0) + b.order;
}

function best(list: Binding[]): Binding | undefined {
  let winner: Binding | undefined;
  for (const b of list) if (!winner || rank(b) > rank(winner)) winner = b;
  return winner;
}

function defaultBindings(platform: Platform, catalog: readonly CommandDef[]): Binding[] {
  const out: Binding[] = [];
  for (const def of catalog) {
    const kb = def.keybinding;
    if (!kb) continue;
    const text = platform === 'darwin' ? (kb.mac ?? kb.key) : kb.key;
    const chord = parseChord(text, platform);
    if (!chord) continue;
    out.push({
      commandId: def.id,
      chord,
      canonical: canonicalChord(chord, platform),
      when: kb.when,
      source: 'default',
      order: out.length,
    });
  }
  return out;
}

/**
 * Apply user overrides to the defaults.
 *  - `{ key, command }` adds a binding. It replaces default bindings on the same chord (only those
 *    with the same when clause when the override has one).
 *  - `{ command: "-id" }` removes every default binding of that command.
 * Entries with an unparsable chord or when clause are ignored (the settings slice reports them).
 */
export function applyOverrides(
  defaults: Binding[],
  overrides: readonly KeybindingOverride[],
  platform: Platform,
): Binding[] {
  let list = defaults;
  let order = defaults.length;
  for (const entry of overrides) {
    if (typeof entry.command !== 'string' || entry.command === '') continue;
    if (entry.command.startsWith('-')) {
      const id = entry.command.slice(1);
      list = list.filter((b) => !(b.source === 'default' && b.commandId === id));
      continue;
    }
    const chord = typeof entry.key === 'string' ? parseChord(entry.key, platform) : null;
    if (!chord) continue;
    const when = entry.when?.trim() || undefined;
    if (when && !isValidWhen(when)) continue;
    const canonical = canonicalChord(chord, platform);
    list = list.filter(
      (b) =>
        !(
          b.source === 'default' &&
          b.canonical === canonical &&
          (when === undefined || (b.when ?? '') === when)
        ),
    );
    list = [
      ...list,
      { commandId: entry.command, chord, canonical, when, source: 'user', args: entry.args, order: order++ },
    ];
  }
  return list;
}

export function createKeybindingService(deps: KeybindingServiceDeps): KeybindingServiceImpl {
  const { platform, contexts, commands, target } = deps;
  const catalog = deps.catalog ?? COMMANDS;
  const timeoutMs = deps.chordTimeoutMs ?? CHORD_TIMEOUT_MS;
  const defaults = defaultBindings(platform, catalog);

  let bindings: Binding[] = defaults;
  let pending: Pending | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;
  let replaying = false;
  const listeners = new Set<() => void>();

  const setHint = (text: string | null) => deps.onHint?.(text);

  const clearHintTimer = () => {
    if (hintTimer !== undefined) clearTimeout(hintTimer);
    hintTimer = undefined;
  };

  const clearPending = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
    clearHintTimer();
    setHint(null);
  };

  /** A binding applies when its command can run, its when clause holds and no modal input owns the keys. */
  const isActive = (b: Binding): boolean => {
    if (contexts.get('quickInputVisible') && !b.commandId.startsWith('palette.')) return false;
    return commands.isEnabled(b.commandId) && contexts.evaluate(b.when);
  };

  const consume = (e: KeyDownLike) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const run = (b: Binding) => {
    void commands.execute(b.commandId, b.args);
  };

  const startPending = (e: KeyDownLike, first: Stroke) => {
    const timer = setTimeout(() => {
      pending = null;
      setHint(null);
    }, timeoutMs);
    pending = {
      first,
      target: e.target,
      timer,
      key: {
        key: e.key,
        code: e.code,
        keyCode: e.keyCode ?? 0,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
      },
    };
    setHint(`(${strokeToLabel(first, platform)}) was pressed, waiting for second key...`);
  };

  const singleMatches = (e: KeyDownLike, candidates: ReturnType<typeof keyCandidates>) =>
    bindings.filter(
      (b) =>
        b.chord.length === 1 &&
        eventMatchesStroke(e, b.chord[0] as Stroke, platform, candidates) &&
        isActive(b),
    );

  const firstStepMatches = (e: KeyDownLike, candidates: ReturnType<typeof keyCandidates>) =>
    bindings.filter(
      (b) =>
        b.chord.length === 2 &&
        eventMatchesStroke(e, b.chord[0] as Stroke, platform, candidates) &&
        isActive(b),
    );

  const handleFirst = (e: KeyDownLike, candidates: ReturnType<typeof keyCandidates>): boolean => {
    const full = best(singleMatches(e, candidates));
    if (full) {
      consume(e);
      run(full);
      return true;
    }
    const starters = firstStepMatches(e, candidates);
    if (starters.length === 0) return false;
    consume(e);
    // Holding the starter key down must not restart (or re-time) the chord.
    if (e.repeat) return true;
    const first = strokeFromEvent(e);
    if (first) startPending(e, first);
    return true;
  };

  const handleSecond = (
    e: KeyDownLike,
    candidates: ReturnType<typeof keyCandidates>,
    p: Pending,
  ): boolean => {
    if (e.repeat && eventMatchesStroke(e, p.first, platform, candidates)) {
      consume(e);
      return true;
    }
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      clearPending();
      consume(e);
      return true;
    }
    const seconds = bindings.filter(
      (b) =>
        b.chord.length === 2 &&
        strokesEqual(b.chord[0] as Stroke, p.first) &&
        eventMatchesStroke(e, b.chord[1] as Stroke, platform, candidates) &&
        isActive(b),
    );
    const match = best(seconds);
    clearPending();
    if (match) {
      consume(e);
      run(match);
      return true;
    }

    // Monaco has chords of its own (for example Ctrl+K Ctrl+C). Give it the first key again and
    // let the second one through so it can finish the chord.
    if (deps.isEditorTarget?.(e.target) && deps.replayKey) {
      replaying = true;
      try {
        deps.replayKey(e.target, p.key);
      } finally {
        replaying = false;
      }
      return false;
    }

    consume(e);
    const second = strokeFromEvent(e);
    if (second) {
      setHint(
        `The key combination (${strokeToLabel(p.first, platform)}, ${strokeToLabel(second, platform)}) is not a command.`,
      );
      hintTimer = setTimeout(() => {
        hintTimer = undefined;
        setHint(null);
      }, timeoutMs);
    }
    return true;
  };

  const handleKeyDown = (e: KeyDownLike): boolean => {
    if (replaying || composing || e.isComposing || e.keyCode === 229) return false;
    if (isModifierOnly(e)) return false;
    const candidates = keyCandidates(e);
    if (candidates.length === 0 || isAltGraph(e, platform)) return false;
    clearHintTimer();
    if (pending) return handleSecond(e, candidates, pending);
    return handleFirst(e, candidates);
  };

  const setOverrides = (entries: readonly KeybindingOverride[]) => {
    bindings = applyOverrides(defaults, entries, platform);
    clearPending();
    for (const listener of [...listeners]) listener();
  };

  const orderedFor = (commandId: string): Binding[] =>
    bindings
      .filter((b) => b.commandId === commandId)
      .sort((a, b) => rank(b) - rank(a));

  return {
    start() {
      let stopped = false;
      const onKeyDown = (e: KeyboardEvent) => void handleKeyDown(e);
      const onCompositionStart = () => {
        composing = true;
      };
      const onCompositionEnd = () => {
        composing = false;
      };
      const onBlur = () => clearPending();

      target.addEventListener('keydown', onKeyDown as (event: never) => void, true);
      target.addEventListener('compositionstart', onCompositionStart, true);
      target.addEventListener('compositionend', onCompositionEnd, true);
      target.addEventListener('blur', onBlur, true);

      const stopChanges = deps.onOverridesChanged((entries) => setOverrides(entries));
      void deps
        .loadOverrides()
        .then((entries) => {
          if (!stopped) setOverrides(entries);
        })
        .catch(() => {
          // Without a readable keybindings file the defaults stay in force.
        });

      return () => {
        stopped = true;
        stopChanges();
        clearPending();
        target.removeEventListener('keydown', onKeyDown as (event: never) => void, true);
        target.removeEventListener('compositionstart', onCompositionStart, true);
        target.removeEventListener('compositionend', onCompositionEnd, true);
        target.removeEventListener('blur', onBlur, true);
      };
    },

    all(): ResolvedKeybinding[] {
      return bindings.map((b) => ({
        commandId: b.commandId,
        chord: b.canonical,
        when: b.when,
        source: b.source,
      }));
    },

    labelFor(commandId) {
      const top = orderedFor(commandId)[0];
      return top ? chordLabel(top.chord, platform) : undefined;
    },

    onDidChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    handleKeyDown,
    setOverrides,
    cancelChord: clearPending,
  };
}
