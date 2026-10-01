import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KeybindingsSnapshot } from '@shared/api/settings';
import { COMMANDS } from '@shared/commands/catalog';
import {
  normalizeChord,
  parseKeybindings,
} from '../../../src/main/settings/keybindings';
import { KeybindingsService } from '../../../src/main/settings/keybindings-service';
import { KEYBINDINGS_TEMPLATE } from '../../../src/main/settings/templates';
import { recordingLogger, tempDir, waitFor } from './helpers';

const FILE = '/u/keybindings.json';
const parse = (text: string | null) => parseKeybindings(text, FILE);

describe('normalizeChord', () => {
  it.each([
    ['Mod+Shift+P', 'Mod+Shift+P'],
    ['mod+shift+p', 'Mod+Shift+P'],
    ['ctrl+alt+delete', 'Ctrl+Alt+Delete'],
    ['Command+Option+ArrowUp', 'Cmd+Alt+ArrowUp'],
    ['Mod+K Mod+S', 'Mod+K Mod+S'],
    ['  mod+k    mod+s ', 'Mod+K Mod+S'],
    ['Mod+k Mod+left', 'Mod+K Mod+ArrowLeft'],
    ['F5', 'F5'],
    ['f12', 'F12'],
    ['Shift+F10', 'Shift+F10'],
    ['Escape', 'Escape'],
    ['Mod+`', 'Mod+`'],
    ['Ctrl+Shift+[', 'Ctrl+Shift+['],
    ['Mod+/', 'Mod+/'],
    ['Alt+PgDn', 'Alt+PageDown'],
    ['Mod+1', 'Mod+1'],
    ['Mod+Enter', 'Mod+Enter'],
  ])('accepts %s as %s', (input, expected) => {
    expect(normalizeChord(input)).toEqual({ ok: true, chord: expected });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['Mod+', 'missing'],
    ['Mod+Shift', 'not a key name'],
    ['Hyper+P', 'not a modifier'],
    ['Mod+Mod+P', 'repeated'],
    ['Mod+Foo', 'not a key name'],
    ['Mod+K Mod+S Mod+T', 'at most 2'],
    ['P', 'needs a modifier'],
    ['5', 'needs a modifier'],
    ['Space', 'needs a modifier'],
  ])('rejects %j', (input) => {
    expect(normalizeChord(input).ok).toBe(false);
  });

  it('explains why a chord was rejected', () => {
    const result = normalizeChord('Hyper+P');
    expect(result).toEqual({ ok: false, reason: '"Hyper" is not a modifier.' });
    const bare = normalizeChord('P');
    expect(bare.ok === false && bare.reason).toContain('needs a modifier');
  });

  it('allows non-printing keys without a modifier, in the first step and later steps', () => {
    expect(normalizeChord('Mod+K Escape')).toEqual({ ok: true, chord: 'Mod+K Escape' });
    expect(normalizeChord('Mod+K P')).toEqual({ ok: true, chord: 'Mod+K P' });
    expect(normalizeChord('Delete').ok).toBe(true);
  });

  it('accepts every default chord in the command catalog', () => {
    const chords: string[] = [];
    for (const c of COMMANDS) {
      if (c.keybinding) chords.push(c.keybinding.key, ...(c.keybinding.mac ? [c.keybinding.mac] : []));
      if (c.keybindingHint) chords.push(c.keybindingHint);
    }
    expect(chords.length).toBeGreaterThan(20);
    for (const chord of chords) {
      const result = normalizeChord(chord);
      expect(result.ok, `${chord}: ${result.ok ? '' : result.reason}`).toBe(true);
      if (result.ok) expect(result.chord).toBe(chord);
    }
  });
});

describe('parseKeybindings', () => {
  it('treats a missing or empty file as having no overrides', () => {
    expect(parse(null)).toEqual({ entries: [], issues: [], syntaxError: false });
    expect(parse('')).toEqual({ entries: [], issues: [], syntaxError: false });
    expect(parse('// nothing\n[]')).toEqual({ entries: [], issues: [], syntaxError: false });
  });

  it('parses entries with comments and trailing commas and canonicalises the chord', () => {
    const result = parse(`[
      // format
      { "key": "mod+alt+l", "command": "edit.formatDocument", "when": "hasActiveEditor", },
      { "key": "Mod+Shift+K", "command": "-edit.formatDocument" },
      { "key": "Mod+Alt+O", "command": "terminal.runCommand", "args": { "command": "ls" } },
    ]`);
    expect(result.issues).toEqual([]);
    expect(result.entries).toEqual([
      { key: 'Mod+Alt+L', command: 'edit.formatDocument', when: 'hasActiveEditor' },
      { key: 'Mod+Shift+K', command: '-edit.formatDocument' },
      { key: 'Mod+Alt+O', command: 'terminal.runCommand', args: { command: 'ls' } },
    ]);
  });

  it('keeps unknown command ids and reports them', () => {
    const result = parse('[\n  { "key": "Mod+Alt+Q", "command": "plugin.doesNotExist" }\n]');
    expect(result.entries).toEqual([{ key: 'Mod+Alt+Q', command: 'plugin.doesNotExist' }]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ file: FILE, line: 2, key: 'plugin.doesNotExist' });
    expect(result.issues[0]?.message).toContain('not a known command');
  });

  it('checks the command behind a removal entry', () => {
    const known = parse('[{ "key": "Mod+P", "command": "-edit.formatDocument" }]');
    expect(known.issues).toEqual([]);
    const unknown = parse('[{ "key": "Mod+P", "command": "-nothing.here" }]');
    expect(unknown.issues).toHaveLength(1);
    expect(unknown.entries).toHaveLength(1);
  });

  it('drops entries with an invalid chord', () => {
    const result = parse('[{ "key": "Hyper+P", "command": "edit.formatDocument" }]');
    expect(result.entries).toEqual([]);
    expect(result.issues[0]?.message).toContain('Invalid key "Hyper+P"');
    expect(result.issues[0]?.message).toContain('ignored');
  });

  it('drops entries with an invalid when clause', () => {
    const result = parse(
      '[{ "key": "Mod+Alt+L", "command": "edit.formatDocument", "when": "editorFocus &&" }]',
    );
    expect(result.entries).toEqual([]);
    expect(result.issues[0]?.message).toContain('Invalid "when" clause');
  });

  it('accepts operators and parentheses in when clauses', () => {
    const result = parse(
      `[{ "key": "Mod+Alt+L", "command": "edit.formatDocument", "when": "(editorFocus || terminalFocus) && !isMac && activeSidebar == 'git'" }]`,
    );
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(1);
  });

  it('reports entries that are missing parts or have the wrong type', () => {
    const result = parse(`[
      { "key": "Mod+Alt+L" },
      { "command": "edit.formatDocument" },
      { "key": 5, "command": "edit.formatDocument" },
      { "key": "Mod+Alt+L", "command": 7 },
      "text",
      42,
      [1],
      null
    ]`);
    expect(result.entries).toEqual([]);
    expect(result.issues).toHaveLength(8);
    expect(result.syntaxError).toBe(false);
  });

  it('reports unknown fields but keeps the entry', () => {
    const result = parse('[{ "key": "Mod+Alt+L", "command": "edit.formatDocument", "color": "red" }]');
    expect(result.entries).toEqual([{ key: 'Mod+Alt+L', command: 'edit.formatDocument' }]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.message).toContain('"color"');
  });

  it('flags a syntax error and keeps no entries', () => {
    const result = parse('[{ "key": "Mod+Alt+L", "command": }]');
    expect(result.syntaxError).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.issues[0]?.message).toContain('previous shortcuts stay in effect');
  });

  it('requires a list at the top level', () => {
    const result = parse('{ "key": "Mod+Alt+L", "command": "edit.formatDocument" }');
    expect(result.syntaxError).toBe(true);
    expect(result.issues[0]?.message).toContain('must contain a list');
  });

  it('reports the line of each problem', () => {
    const result = parse(
      '[\n  { "key": "Mod+Alt+L", "command": "edit.formatDocument" },\n  { "key": "Q", "command": "edit.formatDocument" }\n]',
    );
    expect(result.issues[0]?.line).toBe(3);
  });

  it('accepts the template that "Open keyboard shortcuts (JSON)" creates', () => {
    expect(parse(KEYBINDINGS_TEMPLATE)).toEqual({ entries: [], issues: [], syntaxError: false });
  });
});

describe('KeybindingsService', () => {
  function setup(initial?: string, watch = false) {
    const userDataDir = tempDir('inc-kb-');
    const file = path.join(userDataDir, 'keybindings.json');
    if (initial !== undefined) writeFileSync(file, initial);
    const logger = recordingLogger();
    const service = new KeybindingsService({ userDataDir, logger, watch, debounceMs: 20 });
    const events: KeybindingsSnapshot[] = [];
    service.onDidChange((s) => events.push(s));
    return { file, logger, service, events };
  }

  const ONE = '[{ "key": "Mod+Alt+L", "command": "edit.formatDocument" }]';

  it('starts empty when there is no file', () => {
    const { service, file } = setup();
    expect(service.snapshot()).toEqual({ entries: [], issues: [], file });
  });

  it('creates the file with the template and returns its path, without overwriting', async () => {
    const { service, file } = setup();
    expect(await service.ensureFile()).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(KEYBINDINGS_TEMPLATE);
    writeFileSync(file, ONE);
    expect(await service.ensureFile()).toBe(file);
    expect(readFileSync(file, 'utf8')).toBe(ONE);
    expect(service.snapshot().entries).toHaveLength(1);
  });

  it('loads entries at startup and logs problems once', () => {
    const { service, logger } = setup(
      '[{ "key": "Mod+Alt+L", "command": "nothing.here" }, { "key": "Q", "command": "edit.formatDocument" }]',
    );
    expect(service.snapshot().entries).toHaveLength(1);
    expect(service.snapshot().issues).toHaveLength(2);
    expect(logger.warnings.filter((w) => w.startsWith('Keybindings:'))).toHaveLength(2);
  });

  it('reloads on demand and reports whether anything changed', () => {
    const { service, file, events } = setup(ONE);
    expect(service.reload()).toBe(false);
    writeFileSync(file, '[{ "key": "Mod+Alt+M", "command": "edit.formatDocument" }]');
    expect(service.reload()).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.entries[0]?.key).toBe('Mod+Alt+M');
  });

  it('keeps the last good shortcuts while the file has a syntax error', () => {
    const { service, file } = setup(ONE);
    writeFileSync(file, '[{ "key": "Mod+Alt+L", "command": ');
    service.reload();
    const snapshot = service.snapshot();
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.issues[0]?.message).toContain('previous shortcuts stay in effect');
    writeFileSync(file, '[]');
    service.reload();
    expect(service.snapshot()).toEqual({ entries: [], issues: [], file });
  });

  it('clears the shortcuts when the file is deleted', () => {
    const { service, file } = setup(ONE);
    rmSync(file);
    expect(service.reload()).toBe(true);
    expect(service.snapshot().entries).toEqual([]);
  });

  it('follows edits made by other programs', async () => {
    const { service, file, events } = setup(undefined, true);
    try {
      writeFileSync(file, ONE);
      await waitFor(() => events.length > 0, 'keybindings change event');
      expect(events.at(-1)?.entries).toHaveLength(1);
    } finally {
      service.dispose();
    }
  });
});
