import { describe, expect, it } from 'vitest';
import {
  canonicalChord,
  chordLabel,
  eventMatchesStroke,
  isAltGraph,
  isModifierOnly,
  keyCandidates,
  normalizeChord,
  parseChord,
  splitLabel,
  strokeFromEvent,
  type KeyEventLike,
} from '../../../src/shared/keys';

const ev = (init: Partial<KeyEventLike> & { key: string; code: string }): KeyEventLike => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
});

describe('chord parsing', () => {
  it('resolves Mod to Ctrl on Windows and Linux and to Cmd on macOS', () => {
    expect(parseChord('Mod+S', 'win32')).toEqual([
      { ctrl: true, meta: false, alt: false, shift: false, key: 'S' },
    ]);
    expect(parseChord('Mod+S', 'linux')?.[0]?.ctrl).toBe(true);
    expect(parseChord('Mod+S', 'darwin')).toEqual([
      { ctrl: false, meta: true, alt: false, shift: false, key: 'S' },
    ]);
  });

  it('accepts two steps and rejects three', () => {
    expect(parseChord('Mod+K Mod+S', 'win32')).toHaveLength(2);
    expect(parseChord('Mod+K Mod+S Mod+D', 'win32')).toBeNull();
  });

  it('rejects empty text, unknown keys and a modifier with no key', () => {
    expect(parseChord('', 'win32')).toBeNull();
    expect(parseChord('Mod+Banana', 'win32')).toBeNull();
    expect(parseChord('Mod+', 'win32')).toBeNull();
  });

  it('is case-insensitive for modifiers and uses canonical key names', () => {
    expect(normalizeChord('ctrl+shift+p', 'win32')).toBe('Mod+Shift+P');
    expect(normalizeChord('mod+esc', 'win32')).toBe('Mod+Escape');
    expect(normalizeChord('Mod+up', 'win32')).toBe('Mod+ArrowUp');
    expect(normalizeChord('Mod+Plus', 'win32')).toBe('Mod++');
  });

  it('writes the same chord the same way regardless of how it was typed', () => {
    const a = canonicalChord(parseChord('Shift+Ctrl+P', 'win32') ?? [], 'win32');
    const b = canonicalChord(parseChord('Mod+Shift+P', 'win32') ?? [], 'win32');
    expect(a).toBe(b);
  });

  it('keeps Ctrl and Cmd apart on macOS', () => {
    expect(normalizeChord('Ctrl+Tab', 'darwin')).toBe('Ctrl+Tab');
    expect(normalizeChord('Cmd+Tab', 'darwin')).toBe('Mod+Tab');
  });
});

describe('labels', () => {
  it('writes PC labels with plus signs and macOS labels with symbols', () => {
    const chord = parseChord('Mod+Shift+P', 'win32') ?? [];
    expect(chordLabel(chord, 'win32')).toBe('Ctrl+Shift+P');
    const mac = parseChord('Mod+Shift+P', 'darwin') ?? [];
    expect(chordLabel(mac, 'darwin')).toBe('⇧⌘P');
  });

  it('splits labels into one entry per key', () => {
    expect(splitLabel('Ctrl+Shift+P')).toEqual([['Ctrl', 'Shift', 'P']]);
    expect(splitLabel('Ctrl+K Ctrl+S')).toEqual([
      ['Ctrl', 'K'],
      ['Ctrl', 'S'],
    ]);
    expect(splitLabel('⇧⌘P')).toEqual([['⇧', '⌘', 'P']]);
  });
});

describe('matching key events', () => {
  const stroke = (text: string) => parseChord(text, 'win32')?.[0] ?? (null as never);

  it('matches letters by the typed character, so other layouts work', () => {
    // Dvorak: the physical KeyS position types "o"; Ctrl+O must match, Ctrl+S must not.
    const e = ev({ key: 'o', code: 'KeyS', ctrlKey: true });
    expect(eventMatchesStroke(e, stroke('Mod+O'), 'win32')).toBe(true);
    expect(eventMatchesStroke(e, stroke('Mod+S'), 'win32')).toBe(false);
  });

  it('falls back to the physical key for non-Latin layouts', () => {
    const e = ev({ key: 'ы', code: 'KeyS', ctrlKey: true });
    expect(eventMatchesStroke(e, stroke('Mod+S'), 'win32')).toBe(true);
  });

  it('requires the exact modifier set', () => {
    const plain = ev({ key: 's', code: 'KeyS', ctrlKey: true });
    const withShift = ev({ key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true });
    expect(eventMatchesStroke(plain, stroke('Mod+Shift+S'), 'win32')).toBe(false);
    expect(eventMatchesStroke(withShift, stroke('Mod+Shift+S'), 'win32')).toBe(true);
    expect(eventMatchesStroke(withShift, stroke('Mod+S'), 'win32')).toBe(false);
  });

  it('does not treat AltGr text entry as a shortcut', () => {
    const e = ev({
      key: '@',
      code: 'KeyQ',
      ctrlKey: true,
      altKey: true,
      getModifierState: (k) => k === 'AltGraph',
    });
    expect(isAltGraph(e, 'win32')).toBe(true);
    expect(isAltGraph(e, 'darwin')).toBe(false);
    expect(eventMatchesStroke(e, stroke('Mod+Alt+Q'), 'win32')).toBe(false);
  });

  it('reads punctuation from the character and from the physical key', () => {
    const e = ev({ key: '`', code: 'Backquote', ctrlKey: true });
    expect(keyCandidates(e).map((c) => c.key)).toContain('`');
    expect(eventMatchesStroke(e, stroke('Mod+`'), 'win32')).toBe(true);
  });

  it('lets the numpad plus and minus act like the main row', () => {
    const add = ev({ key: '+', code: 'NumpadAdd', ctrlKey: true });
    expect(keyCandidates(add).map((c) => c.key)).toContain('=');
  });

  it('ignores modifier-only and composing keys', () => {
    expect(isModifierOnly({ key: 'Control' })).toBe(true);
    expect(isModifierOnly({ key: 'Shift' })).toBe(true);
    expect(isModifierOnly({ key: 'a' })).toBe(false);
    expect(keyCandidates(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toEqual([]);
    expect(strokeFromEvent(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }))).toBeNull();
  });

  it('builds the stroke to record from an event', () => {
    expect(strokeFromEvent(ev({ key: 'p', code: 'KeyP', ctrlKey: true, shiftKey: true }))).toEqual({
      ctrl: true,
      meta: false,
      alt: false,
      shift: true,
      key: 'P',
    });
  });
});
