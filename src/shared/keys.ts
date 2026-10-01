/**
 * Keybinding notation: parsing, normalisation, display labels and keyboard event matching.
 *
 * Pure and dependency-free (no DOM access) so it can be unit tested with plain objects shaped
 * like KeyboardEvent. The catalog notation is documented in shared/commands/types.ts:
 * modifiers joined with "+", chords separated by a space, "Mod" = Ctrl on Windows and Linux
 * and Cmd on macOS.
 */
import type { Platform } from './paths';

/** A single key press with its modifiers, already resolved for one platform (Mod is gone). */
export interface Stroke {
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  /** Canonical key name: "A".."Z", "0".."9", "F1".., "Enter", "ArrowUp", "`", "\\", "+" ... */
  key: string;
}

/** One or two strokes. */
export type Chord = Stroke[];

/** The parts of KeyboardEvent this module reads. Plain objects can stand in for real events. */
export interface KeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (key: string) => boolean;
}

export const MAX_CHORD_LENGTH = 2;

const MODIFIER_PREFIX = /^(mod|ctrl|control|cmd|command|meta|super|win|alt|option|shift)\+/i;

const NAMED_KEYS: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  enter: 'Enter',
  return: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  ins: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'ArrowUp',
  arrowup: 'ArrowUp',
  down: 'ArrowDown',
  arrowdown: 'ArrowDown',
  left: 'ArrowLeft',
  arrowleft: 'ArrowLeft',
  right: 'ArrowRight',
  arrowright: 'ArrowRight',
  plus: '+',
};

/** Canonical key name for the text used in a binding, or null when it is not a key we know. */
export function normalizeKeyName(raw: string): string | null {
  if (raw.length === 1) {
    if (raw === ' ') return 'Space';
    return /[a-z]/i.test(raw) ? raw.toUpperCase() : raw;
  }
  const lower = raw.toLowerCase();
  const named = NAMED_KEYS[lower];
  if (named) return named;
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  return fn ? `F${fn[1]}` : null;
}

function parseStroke(text: string, platform: Platform): Stroke | null {
  const mac = platform === 'darwin';
  let rest = text.trim();
  const stroke: Stroke = { ctrl: false, meta: false, alt: false, shift: false, key: '' };
  for (;;) {
    const m = MODIFIER_PREFIX.exec(rest);
    if (!m) break;
    rest = rest.slice(m[0].length);
    switch ((m[1] as string).toLowerCase()) {
      case 'mod':
        if (mac) stroke.meta = true;
        else stroke.ctrl = true;
        break;
      case 'ctrl':
      case 'control':
        stroke.ctrl = true;
        break;
      case 'alt':
      case 'option':
        stroke.alt = true;
        break;
      case 'shift':
        stroke.shift = true;
        break;
      default:
        stroke.meta = true;
    }
  }
  const key = normalizeKeyName(rest);
  if (!key) return null;
  stroke.key = key;
  return stroke;
}

/** Parse "Mod+K Mod+S" for a platform. Returns null for anything that is not a valid chord. */
export function parseChord(text: string, platform: Platform): Chord | null {
  const parts = text.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > MAX_CHORD_LENGTH || parts[0] === '') return null;
  const chord: Chord = [];
  for (const part of parts) {
    const stroke = parseStroke(part, platform);
    if (!stroke) return null;
    chord.push(stroke);
  }
  return chord;
}

function canonicalStroke(s: Stroke, platform: Platform): string {
  const mac = platform === 'darwin';
  const out: string[] = [];
  if (mac) {
    if (s.meta) out.push('Mod');
    if (s.ctrl) out.push('Ctrl');
  } else {
    if (s.ctrl) out.push('Mod');
    if (s.meta) out.push('Cmd');
  }
  if (s.alt) out.push('Alt');
  if (s.shift) out.push('Shift');
  out.push(s.key);
  return out.join('+');
}

/** Stable text form used for comparison and for `ResolvedKeybinding.chord`, e.g. "Mod+Shift+P". */
export function canonicalChord(chord: Chord, platform: Platform): string {
  return chord.map((s) => canonicalStroke(s, platform)).join(' ');
}

/** Normalise a chord written in the catalog or user notation; null when invalid. */
export function normalizeChord(text: string, platform: Platform): string | null {
  const chord = parseChord(text, platform);
  return chord ? canonicalChord(chord, platform) : null;
}

export function strokesEqual(a: Stroke, b: Stroke): boolean {
  return (
    a.ctrl === b.ctrl &&
    a.meta === b.meta &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.key === b.key
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const MAC_KEY_LABELS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↩',
  Escape: '⎋',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
};

const PC_KEY_LABELS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Delete: 'Del',
};

function strokeLabel(s: Stroke, platform: Platform): string {
  if (platform === 'darwin') {
    const mods =
      (s.ctrl ? '⌃' : '') + (s.alt ? '⌥' : '') + (s.shift ? '⇧' : '') + (s.meta ? '⌘' : '');
    return mods + (MAC_KEY_LABELS[s.key] ?? s.key);
  }
  const out: string[] = [];
  if (s.ctrl) out.push('Ctrl');
  if (s.alt) out.push('Alt');
  if (s.shift) out.push('Shift');
  if (s.meta) out.push(platform === 'win32' ? 'Win' : 'Super');
  out.push(PC_KEY_LABELS[s.key] ?? s.key);
  return out.join('+');
}

/** Platform label: "Ctrl+Shift+P" on Windows and Linux, "⇧⌘P" on macOS. */
export function chordLabel(chord: Chord, platform: Platform): string {
  return chord.map((s) => strokeLabel(s, platform)).join(' ');
}

/** Label for a single stroke, used in the "waiting for second key" hint. */
export function strokeToLabel(stroke: Stroke, platform: Platform): string {
  return strokeLabel(stroke, platform);
}

const MAC_MODIFIER_SYMBOLS = '⌃⌥⇧⌘';

/**
 * Split a label produced by `chordLabel` into one entry per key, grouped by chord step, for
 * rendering one chip per key: "Ctrl+Shift+P" -> [["Ctrl","Shift","P"]], "⇧⌘P" ->
 * [["⇧","⌘","P"]], "Ctrl+K Ctrl+S" -> [["Ctrl","K"],["Ctrl","S"]].
 */
export function splitLabel(label: string): string[][] {
  const groups: string[][] = [];
  for (const step of label.trim().split(/\s+/)) {
    if (!step) continue;
    const keys: string[] = [];
    let rest = step;
    while (rest.length > 0 && MAC_MODIFIER_SYMBOLS.includes(rest[0] as string)) {
      keys.push(rest[0] as string);
      rest = rest.slice(1);
    }
    if (rest.includes('+') && rest !== '+') {
      const pieces = rest.split('+');
      // "Ctrl++" splits to ["Ctrl", "", ""]: the trailing pair is the plus key itself.
      if (
        pieces.length >= 2 &&
        pieces[pieces.length - 1] === '' &&
        pieces[pieces.length - 2] === ''
      ) {
        pieces.splice(pieces.length - 2, 2, '+');
      }
      keys.push(...pieces.filter((p) => p !== ''));
    } else if (rest) {
      keys.push(rest);
    }
    groups.push(keys);
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Event matching
// ---------------------------------------------------------------------------

/** Physical keys that produce punctuation, so bindings work on layouts that move the character. */
const CODE_PUNCTUATION: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

const LEGACY_KEY_NAMES: Record<string, string> = {
  Esc: 'Escape',
  Del: 'Delete',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Spacebar: 'Space',
  ' ': 'Space',
};

const NON_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'AltGraph',
  'OS',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Fn',
  'FnLock',
  'Hyper',
  'Super',
  'Symbol',
  'SymbolLock',
  'Dead',
  'Unidentified',
  'Process',
  'Compose',
]);

/** True for a keydown that only changes modifier state (Ctrl, Shift, Alt, Meta ...). */
export function isModifierOnly(e: Pick<KeyEventLike, 'key'>): boolean {
  return NON_KEYS.has(e.key);
}

/** One reading of an event: the key it can be taken to mean and whether Shift still counts. */
export interface KeyCandidate {
  key: string;
  shift: boolean;
}

/**
 * The readings of a key event. Letters use `event.key` (so Dvorak and AZERTY work) and fall back
 * to `event.code` when `key` is not a Latin letter (Cyrillic layouts, macOS Option combos).
 * Digits and punctuation are read from both `code` and `key`; when the character itself already
 * needed Shift (`Shift+7` = "/" on German layouts) that Shift is consumed by the character.
 */
export function keyCandidates(e: KeyEventLike): KeyCandidate[] {
  if (NON_KEYS.has(e.key)) return [];
  const out: KeyCandidate[] = [];
  const add = (key: string, shift: boolean) => {
    if (!out.some((c) => c.key === key && c.shift === shift)) out.push({ key, shift });
  };
  const { key, code } = e;
  const letterCode = /^Key([A-Z])$/.exec(code)?.[1];
  const digitCode = /^Digit([0-9])$/.exec(code)?.[1];

  if (key.length === 1 && key !== ' ') {
    if (/[a-z]/i.test(key)) {
      add(key.toUpperCase(), e.shiftKey);
    } else if (/[0-9]/.test(key)) {
      add(key, e.shiftKey);
    } else {
      // The character already includes any Shift that was needed to type it.
      add(key, false);
      // Not a Latin letter (Cyrillic layouts, macOS Option combinations): use the physical key.
      if (letterCode) add(letterCode, e.shiftKey);
    }
  } else {
    add(LEGACY_KEY_NAMES[key] ?? key, e.shiftKey);
  }

  if (digitCode) add(digitCode, e.shiftKey);
  const punctuation = CODE_PUNCTUATION[code];
  if (punctuation) add(punctuation, e.shiftKey);

  // The numpad plus and minus zoom like the main-row keys.
  if (code === 'NumpadAdd') add('=', false);
  if (code === 'NumpadSubtract') add('-', false);
  if (code === 'NumpadEnter') add('Enter', e.shiftKey);

  return out;
}

/** True when AltGr is held on a layout that reports it as Ctrl+Alt (produces text, not shortcuts). */
export function isAltGraph(e: KeyEventLike, platform: Platform): boolean {
  if (platform === 'darwin') return false;
  return Boolean(e.altKey && e.ctrlKey && e.getModifierState?.('AltGraph'));
}

/** Whether a key event is the given stroke. */
export function eventMatchesStroke(
  e: KeyEventLike,
  stroke: Stroke,
  platform: Platform,
  candidates: KeyCandidate[] = keyCandidates(e),
): boolean {
  if (e.ctrlKey !== stroke.ctrl || e.metaKey !== stroke.meta || e.altKey !== stroke.alt) {
    return false;
  }
  if (isAltGraph(e, platform)) return false;
  return candidates.some((c) => c.key === stroke.key && c.shift === stroke.shift);
}

/** The stroke a key event represents, for reporting an unknown chord. Null for modifier-only events. */
export function strokeFromEvent(e: KeyEventLike): Stroke | null {
  const candidates = keyCandidates(e);
  const first = candidates[0];
  if (!first) return null;
  return {
    ctrl: e.ctrlKey,
    meta: e.metaKey,
    alt: e.altKey,
    shift: first.shift,
    key: first.key,
  };
}
