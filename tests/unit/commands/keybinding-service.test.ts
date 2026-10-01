import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandDef } from '../../../src/shared/commands/types';
import {
  createKeybindingService,
  type KeyDownLike,
  type KeybindingServiceImpl,
} from '../../../src/renderer/commands/keybinding-service';

const catalog: CommandDef[] = [
  { id: 'file.save', title: 'Save', keybinding: { key: 'Mod+S' } },
  { id: 'view.sidebar', title: 'Sidebar', keybinding: { key: 'Mod+B' } },
  { id: 'edit.find', title: 'Find', keybinding: { key: 'Mod+F', when: 'editorFocus' } },
  { id: 'palette.open', title: 'Palette', keybinding: { key: 'Mod+Shift+P' } },
  { id: 'settings.keys', title: 'Keys', keybinding: { key: 'Mod+K Mod+S' } },
  { id: 'edit.format', title: 'Format', keybinding: { key: 'Mod+K Mod+F' } },
  { id: 'mac.only', title: 'Mac', keybinding: { key: 'Mod+J', mac: 'Mod+Alt+J' } },
];

function key(k: string, init: Partial<KeyDownLike> = {}): KeyDownLike & { prevented: boolean } {
  const e = {
    key: k,
    code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    prevented: false,
    preventDefault() {
      e.prevented = true;
    },
    stopPropagation() {},
    ...init,
  } as KeyDownLike & { prevented: boolean };
  return e;
}

describe('keybinding service', () => {
  let ctx: Record<string, boolean>;
  let execute: ReturnType<typeof vi.fn>;
  let hints: (string | null)[];
  let overridesChanged: ((e: never) => void) | null;
  let service: KeybindingServiceImpl;

  const make = (platform: 'win32' | 'darwin' = 'win32', extra = {}) =>
    createKeybindingService({
      platform,
      catalog,
      contexts: {
        get: (k) => ctx[k] ?? false,
        set: () => undefined,
        evaluate: (w) => !w || ctx[w] === true,
        onDidChange: () => () => undefined,
      },
      commands: { execute: execute as never, isEnabled: () => true },
      loadOverrides: async () => [],
      onOverridesChanged: (cb) => {
        overridesChanged = cb as never;
        return () => undefined;
      },
      target: { addEventListener() {}, removeEventListener() {} },
      onHint: (t) => hints.push(t),
      chordTimeoutMs: 1500,
      ...extra,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    ctx = {};
    execute = vi.fn();
    hints = [];
    overridesChanged = null;
    service = make();
  });
  afterEach(() => vi.useRealTimers());

  it('runs a single-step binding and consumes the key', () => {
    const e = key('s');
    expect(service.handleKeyDown(e)).toBe(true);
    expect(e.prevented).toBe(true);
    expect(execute).toHaveBeenCalledWith('file.save', undefined);
  });

  it('leaves unbound keys alone', () => {
    const e = key('q');
    expect(service.handleKeyDown(e)).toBe(false);
    expect(e.prevented).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('honours when clauses', () => {
    expect(service.handleKeyDown(key('f'))).toBe(false);
    ctx.editorFocus = true;
    expect(service.handleKeyDown(key('f'))).toBe(true);
    expect(execute).toHaveBeenCalledWith('edit.find', undefined);
  });

  it('uses Cmd for Mod on macOS and the mac chord when given', () => {
    const mac = make('darwin');
    expect(mac.handleKeyDown(key('s'))).toBe(false);
    expect(mac.handleKeyDown(key('s', { ctrlKey: false, metaKey: true }))).toBe(true);
    expect(mac.handleKeyDown(key('j', { ctrlKey: false, metaKey: true, altKey: true }))).toBe(true);
    expect(execute).toHaveBeenLastCalledWith('mac.only', undefined);
  });

  it('completes a two-step chord and shows the pending hint', () => {
    expect(service.handleKeyDown(key('k'))).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(hints.at(-1)).toContain('waiting for second key');
    expect(service.handleKeyDown(key('s'))).toBe(true);
    expect(execute).toHaveBeenCalledWith('settings.keys', undefined);
    expect(hints.at(-1)).toBeNull();
  });

  it('forgets a half-typed chord after the timeout', () => {
    service.handleKeyDown(key('k'));
    vi.advanceTimersByTime(1600);
    expect(hints.at(-1)).toBeNull();
    // Mod+S now runs Save, not the second step of a chord.
    service.handleKeyDown(key('s'));
    expect(execute).toHaveBeenCalledWith('file.save', undefined);
  });

  it('cancels the chord on Escape and says when the second key is not a command', () => {
    service.handleKeyDown(key('k'));
    expect(service.handleKeyDown(key('Escape', { ctrlKey: false }))).toBe(true);
    expect(hints.at(-1)).toBeNull();
    service.handleKeyDown(key('k'));
    service.handleKeyDown(key('z'));
    expect(hints.at(-1)).toContain('is not a command');
    expect(execute).not.toHaveBeenCalled();
  });

  it('hands an unknown second key back to the editor with the first key replayed', () => {
    const replay = vi.fn();
    const editor = {};
    const svc = make('win32', { isEditorTarget: (t: unknown) => t === editor, replayKey: replay });
    svc.handleKeyDown(key('k', { target: editor }));
    const second = key('c', { target: editor });
    expect(svc.handleKeyDown(second)).toBe(false);
    expect(second.prevented).toBe(false);
    expect(replay).toHaveBeenCalledWith(editor, expect.objectContaining({ key: 'k' }));
  });

  it('ignores key repeat of the chord starter', () => {
    service.handleKeyDown(key('k'));
    const before = hints.length;
    expect(service.handleKeyDown(key('k', { repeat: true }))).toBe(true);
    expect(hints.length).toBe(before);
  });

  it('ignores IME composition and AltGr text entry', () => {
    expect(service.handleKeyDown(key('s', { isComposing: true }))).toBe(false);
    expect(service.handleKeyDown(key('s', { keyCode: 229 }))).toBe(false);
    const altGr = key('s', { altKey: true, getModifierState: (k) => k === 'AltGraph' });
    expect(service.handleKeyDown(altGr)).toBe(false);
  });

  it('lets only palette commands through while the quick input is open', () => {
    ctx.quickInputVisible = true;
    expect(service.handleKeyDown(key('s'))).toBe(false);
    expect(service.handleKeyDown(key('p', { shiftKey: true }))).toBe(true);
    expect(execute).toHaveBeenCalledWith('palette.open', undefined);
  });

  it('keeps shell keys in the terminal except for terminal-safe commands', () => {
    ctx.terminalFocus = true;
    expect(service.handleKeyDown(key('s'))).toBe(false);
    expect(service.handleKeyDown(key('b'))).toBe(true);
  });

  describe('user overrides', () => {
    it('adds a binding and replaces the default on the same chord', () => {
      service.setOverrides([{ key: 'Mod+S', command: 'view.sidebar' }]);
      service.handleKeyDown(key('s'));
      expect(execute).toHaveBeenCalledWith('view.sidebar', undefined);
      expect(execute).not.toHaveBeenCalledWith('file.save', undefined);
    });

    it('removes the defaults of a command with a leading minus', () => {
      service.setOverrides([{ key: '', command: '-file.save' }]);
      expect(service.handleKeyDown(key('s'))).toBe(false);
      expect(service.labelFor('file.save')).toBeUndefined();
    });

    it('passes arguments and ignores invalid entries', () => {
      service.setOverrides([
        { key: 'Mod+Q', command: 'x.run', args: { a: 1 } },
        { key: 'Mod+Banana', command: 'x.bad' },
        { key: 'Mod+W', command: 'x.when', when: '((' },
      ]);
      service.handleKeyDown(key('q'));
      expect(execute).toHaveBeenCalledWith('x.run', { a: 1 });
      expect(service.all().some((b) => b.commandId === 'x.bad' || b.commandId === 'x.when')).toBe(
        false,
      );
    });

    it('picks up overrides pushed by the file watcher and tells listeners', () => {
      const changed = vi.fn();
      service.onDidChange(changed);
      service.start();
      (overridesChanged as unknown as (e: unknown[]) => void)([{ key: 'Mod+Q', command: 'x.run' }]);
      expect(changed).toHaveBeenCalled();
      expect(service.labelFor('x.run')).toBe('Ctrl+Q');
    });
  });

  it('labels the highest priority binding of a command', () => {
    expect(service.labelFor('file.save')).toBe('Ctrl+S');
    service.setOverrides([{ key: 'Mod+Shift+S', command: 'file.save' }]);
    expect(service.labelFor('file.save')).toBe('Ctrl+Shift+S');
    expect(service.labelFor('nothing')).toBeUndefined();
  });
});
