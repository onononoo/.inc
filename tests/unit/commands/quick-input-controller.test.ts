import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOADING_DELAY_MS,
  MAX_RESULTS,
  QuickInputController,
  type QuickItem,
  type SessionSpec,
} from '../../../src/renderer/commands/quick-input-controller';

const item = (id: string): QuickItem => ({ id, label: id });
const items = (...ids: string[]) => ids.map(item);

function pickSpec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    kind: 'pick',
    placeholder: 'Type',
    ariaLabel: 'Pick',
    initialValue: '',
    emptyText: 'Nothing',
    query: (value) => ({
      items: items('apple', 'avocado', 'banana').filter((i) => i.id.includes(value)),
    }),
    accept: vi.fn(),
    ...over,
  };
}

describe('quick input controller', () => {
  let restore: ReturnType<typeof vi.fn>;
  let onVisible: ReturnType<typeof vi.fn>;
  let reportError: ReturnType<typeof vi.fn>;
  let qi: QuickInputController;

  beforeEach(() => {
    vi.useFakeTimers();
    restore = vi.fn();
    onVisible = vi.fn();
    reportError = vi.fn();
    qi = new QuickInputController({
      captureFocus: () => restore as () => void,
      onVisibleChange: onVisible as (v: boolean) => void,
      reportError: reportError as (e: unknown) => void,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('shows the first results with the first row active', () => {
    qi.open(pickSpec());
    const v = qi.getView();
    expect(v.visible).toBe(true);
    expect(v.items.map((i) => i.id)).toEqual(['apple', 'avocado', 'banana']);
    expect(v.activeIndex).toBe(0);
    expect(onVisible).toHaveBeenCalledWith(true);
  });

  it('filters as the value changes and ignores an unchanged value', () => {
    const query = vi.fn(pickSpec().query!);
    qi.open(pickSpec({ query }));
    qi.setValue('an');
    expect(qi.getView().items.map((i) => i.id)).toEqual(['banana']);
    const calls = query.mock.calls.length;
    qi.setValue('an');
    expect(query.mock.calls.length).toBe(calls);
  });

  it('wraps with arrows, clamps with paging and jumps with Home and End', () => {
    qi.open(pickSpec());
    qi.move({ by: -1 });
    expect(qi.getView().activeIndex).toBe(2);
    qi.move({ by: 1 });
    expect(qi.getView().activeIndex).toBe(0);
    qi.move({ by: 10, wrap: false });
    expect(qi.getView().activeIndex).toBe(2);
    qi.move({ to: 'first' });
    expect(qi.getView().activeIndex).toBe(0);
    qi.move({ to: 'last' });
    expect(qi.getView().activeIndex).toBe(2);
  });

  it('tells the spec which row is active as it moves', () => {
    const onActive = vi.fn();
    qi.open(pickSpec({ onActive }));
    qi.move({ by: 1 });
    expect(onActive).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'avocado' }));
  });

  it('accepts the active row, closes and hands focus back', () => {
    const accept = vi.fn();
    qi.open(pickSpec({ accept }));
    qi.move({ by: 1 });
    qi.accept();
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ id: 'avocado' }), '');
    expect(qi.isOpen()).toBe(false);
    expect(restore).toHaveBeenCalledOnce();
    expect(onVisible).toHaveBeenLastCalledWith(false);
  });

  it('accepts a row chosen by index (a click)', () => {
    const accept = vi.fn();
    qi.open(pickSpec({ accept }));
    qi.accept(2);
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ id: 'banana' }), '');
  });

  it('cancel closes, restores focus unless told not to, and calls cancel once', () => {
    const cancel = vi.fn();
    qi.open(pickSpec({ cancel }));
    qi.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    qi.open(pickSpec());
    qi.cancel({ restoreFocus: false });
    expect(restore).toHaveBeenCalledOnce();
  });

  it('replacing a session cancels the old one and keeps the original focus target', () => {
    const cancel = vi.fn();
    qi.open(pickSpec({ cancel }));
    qi.open(pickSpec({ placeholder: 'Second' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    qi.cancel();
    expect(restore).toHaveBeenCalledOnce();
  });

  it('reuses a visible session with the same key and asks for focus again', () => {
    qi.open(pickSpec({ reuseKey: 'palette', initialValue: 'a' }));
    const nonce = qi.getView().focusNonce;
    qi.open(pickSpec({ reuseKey: 'palette', initialValue: 'b' }));
    expect(qi.getView().value).toBe('b');
    expect(qi.getView().focusNonce).toBeGreaterThan(nonce);
  });

  it('shows at most MAX_RESULTS rows and reports the real total', () => {
    const many = Array.from({ length: MAX_RESULTS + 50 }, (_, i) => item(`i${i}`));
    qi.open(pickSpec({ query: () => ({ items: many }) }));
    expect(qi.getView().items).toHaveLength(MAX_RESULTS);
    expect(qi.getView().total).toBe(MAX_RESULTS + 50);
  });

  it('makes the requested item active', () => {
    qi.open(pickSpec({ query: () => ({ items: items('a', 'b', 'c'), activeId: 'c' }) }));
    expect(qi.getView().activeIndex).toBe(2);
  });

  describe('async queries', () => {
    function deferred<T>() {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    }

    it('shows a loading state only after the delay', async () => {
      const d = deferred<{ items: QuickItem[] }>();
      qi.open(pickSpec({ query: () => d.promise }));
      expect(qi.getView().loading).toBe(false);
      vi.advanceTimersByTime(LOADING_DELAY_MS + 1);
      expect(qi.getView().loading).toBe(true);
      d.resolve({ items: items('x') });
      await vi.runAllTimersAsync();
      expect(qi.getView().loading).toBe(false);
      expect(qi.getView().items).toHaveLength(1);
    });

    it('drops the result of a query that was overtaken by typing', async () => {
      const first = deferred<{ items: QuickItem[] }>();
      const second = deferred<{ items: QuickItem[] }>();
      const answers = [first, second];
      qi.open(pickSpec({ query: () => (answers.shift() as typeof first).promise }));
      qi.setValue('b');
      second.resolve({ items: items('new') });
      await vi.runAllTimersAsync();
      first.resolve({ items: items('stale') });
      await vi.runAllTimersAsync();
      expect(qi.getView().items.map((i) => i.id)).toEqual(['new']);
    });

    it('accepts the first result of a pending query when Enter was pressed early', async () => {
      const d = deferred<{ items: QuickItem[] }>();
      const accept = vi.fn();
      qi.open(pickSpec({ query: () => d.promise, accept }));
      qi.accept();
      expect(accept).not.toHaveBeenCalled();
      d.resolve({ items: items('first', 'second') });
      await vi.runAllTimersAsync();
      expect(accept).toHaveBeenCalledWith(expect.objectContaining({ id: 'first' }), '');
    });

    it('keeps the active row across a refresh', () => {
      let refresh!: () => void;
      let list = items('a', 'b', 'c');
      qi.open(
        pickSpec({
          query: () => ({ items: list }),
          attach: (h) => {
            refresh = h.refresh;
            return () => undefined;
          },
        }),
      );
      qi.move({ by: 1 });
      list = items('z', 'b', 'c');
      refresh();
      expect(qi.getView().items[qi.getView().activeIndex]?.id).toBe('b');
    });
  });

  describe('errors', () => {
    it('shows a query failure and reports it', () => {
      qi.open(
        pickSpec({
          query: () => {
            throw new Error('index unavailable');
          },
        }),
      );
      expect(qi.getView().message).toEqual({ tone: 'error', text: 'index unavailable' });
      expect(qi.getView().items).toEqual([]);
      expect(reportError).toHaveBeenCalled();
    });

    it('survives a throwing accept handler', () => {
      qi.open(
        pickSpec({
          accept: () => {
            throw new Error('boom');
          },
        }),
      );
      expect(() => qi.accept()).not.toThrow();
      expect(reportError).toHaveBeenCalled();
    });

    it('survives a throwing error reporter', () => {
      qi.configure({
        reportError: () => {
          throw new Error('reporter');
        },
      });
      qi.open(
        pickSpec({
          query: () => {
            throw new Error('x');
          },
        }),
      );
      expect(qi.isOpen()).toBe(true);
    });
  });

  describe('input sessions', () => {
    const input = (over: Partial<SessionSpec> = {}): SessionSpec => ({
      kind: 'input',
      placeholder: 'Name',
      ariaLabel: 'Name',
      initialValue: '',
      emptyText: '',
      accept: vi.fn(),
      ...over,
    });

    it('validates as the person types and blocks submission on a problem', async () => {
      const accept = vi.fn();
      qi.open(input({ accept, validate: (v) => (v ? undefined : 'A name is required.') }));
      qi.setValue('x');
      qi.setValue('');
      expect(qi.getView().message?.text).toBe('A name is required.');
      qi.accept();
      await vi.runAllTimersAsync();
      expect(accept).not.toHaveBeenCalled();
      expect(qi.isOpen()).toBe(true);
    });

    it('submits the typed value when it is valid', async () => {
      const accept = vi.fn();
      qi.open(input({ accept, validate: () => undefined }));
      qi.setValue('plan.md');
      qi.accept();
      await vi.runAllTimersAsync();
      expect(accept).toHaveBeenCalledWith(undefined, 'plan.md');
      expect(qi.isOpen()).toBe(false);
    });

    it('does not apply a validation result for a value that is gone', async () => {
      let release!: (v: string | undefined) => void;
      qi.open(
        input({
          validate: (v) =>
            v === 'a' ? new Promise<string | undefined>((r) => (release = r)) : undefined,
        }),
      );
      qi.setValue('a');
      qi.setValue('b');
      release('old problem');
      await vi.runAllTimersAsync();
      expect(qi.getView().message).toBeUndefined();
    });
  });
});
