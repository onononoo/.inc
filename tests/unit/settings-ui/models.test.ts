import { describe, expect, it } from 'vitest';
import type { SettingsSnapshot } from '@shared/api/settings';
import { defaultSettings } from '@shared/settings';
import type { SettingKey, SettingValues } from '@shared/settings';
import {
  addEntry,
  commandTitle,
  conflictsFor,
  matchesShortcut,
  parseKeybindingsFile,
  removeBinding,
  removeEntries,
  resetBinding,
  setBinding,
  shortcutRows,
} from '../../../src/renderer/settings-ui/keybindings-model';
import {
  ALL_SETTINGS,
  categoryCounts,
  describeValue,
  matchesQuery,
  parseListInput,
  parseNumberInput,
  rankScore,
  visibleRows,
} from '../../../src/renderer/settings-ui/settings-model';

function snapshot(
  overrides: Partial<SettingsSnapshot> & {
    user?: Partial<SettingValues>;
    workspace?: Partial<SettingValues>;
  } = {},
): SettingsSnapshot {
  const effective = {
    ...defaultSettings(),
    ...(overrides.user ?? {}),
    ...(overrides.workspace ?? {}),
  };
  const sources = Object.fromEntries(
    Object.keys(effective).map((k) => [k, 'default']),
  ) as SettingsSnapshot['sources'];
  for (const k of Object.keys(overrides.user ?? {})) sources[k as SettingKey] = 'user';
  for (const k of Object.keys(overrides.workspace ?? {})) sources[k as SettingKey] = 'workspace';
  return {
    effective,
    sources,
    user: overrides.user ?? {},
    workspace: overrides.workspace ?? {},
    locked: overrides.locked ?? [],
    restrictedIgnored: [],
    issues: [],
    files: { user: '/u/settings.json', workspace: null, policy: null },
  };
}

describe('settings search', () => {
  it('requires every term and looks at title, description, key, category and tags', () => {
    const font = ALL_SETTINGS.find((s) => s.key === 'editor.fontSize')!;
    expect(matchesQuery(font, 'font size')).toBe(true);
    expect(matchesQuery(font, 'editor.fontsize')).toBe(true);
    expect(matchesQuery(font, 'editor font')).toBe(true);
    expect(matchesQuery(font, 'font banana')).toBe(false);
    expect(matchesQuery(font, '')).toBe(true);
    const theme = ALL_SETTINGS.find((s) => s.key === 'appearance.theme')!;
    expect(matchesQuery(theme, 'contrast')).toBe(true); // a tag
  });

  it('ranks title matches above description matches', () => {
    const rows = visibleRows(snapshot(), {
      query: 'font',
      category: 'all',
      scope: 'user',
      trusted: true,
    });
    expect(rows.length).toBeGreaterThan(2);
    const first = rows[0]!;
    expect(first.def.title.toLowerCase()).toContain('font');
    const scores = rows.map((r) => rankScore(r.def, 'font'));
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
  });
});

describe('visible rows', () => {
  it('filters by category, modified and managed', () => {
    const snap = snapshot({ user: { 'editor.fontSize': 16 }, locked: ['editor.tabSize'] });
    const editor = visibleRows(snap, {
      query: '',
      category: 'Editor',
      scope: 'user',
      trusted: true,
    });
    expect(editor.every((r) => r.def.category === 'Editor')).toBe(true);
    expect(
      visibleRows(snap, { query: '', category: 'modified', scope: 'user', trusted: true }).map(
        (r) => r.def.key,
      ),
    ).toEqual(['editor.fontSize']);
    expect(
      visibleRows(snap, { query: '', category: 'managed', scope: 'user', trusted: true }).map(
        (r) => r.def.key,
      ),
    ).toEqual(['editor.tabSize']);
    expect(
      visibleRows(snap, { query: '', category: 'all', scope: 'user', trusted: true }),
    ).toHaveLength(ALL_SETTINGS.length);
  });

  it('shows only workspace-scoped settings in the workspace tab and flags restricted ones when untrusted', () => {
    const snap = snapshot();
    const rows = visibleRows(snap, {
      query: '',
      category: 'all',
      scope: 'workspace',
      trusted: false,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.def.scope === 'workspace')).toBe(true);
    const restricted = ALL_SETTINGS.filter((s) => s.scope === 'workspace' && s.restricted);
    for (const def of restricted) {
      expect(rows.find((r) => r.def.key === def.key)?.restricted).toBe(true);
    }
    const trustedRows = visibleRows(snap, {
      query: '',
      category: 'all',
      scope: 'workspace',
      trusted: true,
    });
    expect(trustedRows.some((r) => r.restricted)).toBe(false);
  });

  it('marks modified per layer and reports the source of the effective value', () => {
    const snap = snapshot({ user: { 'editor.tabSize': 8 }, workspace: { 'editor.tabSize': 2 } });
    const userRow = visibleRows(snap, {
      query: 'tab size',
      category: 'all',
      scope: 'user',
      trusted: true,
    }).find((r) => r.def.key === 'editor.tabSize')!;
    const wsRow = visibleRows(snap, {
      query: 'tab size',
      category: 'all',
      scope: 'workspace',
      trusted: true,
    }).find((r) => r.def.key === 'editor.tabSize')!;
    expect(userRow).toMatchObject({ modified: true, source: 'workspace', value: 2 });
    expect(wsRow.modified).toBe(true);
  });

  it('counts per category for the current search', () => {
    const counts = categoryCounts(
      snapshot({ locked: ['editor.tabSize'], user: { 'editor.fontSize': 15 } }),
      { query: '', scope: 'user', trusted: true },
    );
    expect(counts.all).toBe(ALL_SETTINGS.length);
    expect(counts.Editor).toBe(ALL_SETTINGS.filter((s) => s.category === 'Editor').length);
    expect(counts.modified).toBe(1);
    expect(counts.managed).toBe(1);
  });
});

describe('typed input', () => {
  it('parses plain numbers only', () => {
    expect(parseNumberInput('14')).toBe(14);
    expect(parseNumberInput(' -2.5 ')).toBe(-2.5);
    expect(parseNumberInput('.5')).toBe(0.5);
    for (const bad of ['', 'abc', '1e3', '12px', '1,5', '--1', 'Infinity'])
      expect(parseNumberInput(bad), bad).toBeNull();
  });

  it('splits list input and reports invalid numbers', () => {
    expect(parseListInput(' a, b ,, c ', 'string[]')).toEqual({
      values: ['a', 'b', 'c'],
      invalid: [],
    });
    expect(parseListInput('80, 100, x', 'number[]')).toEqual({ values: [80, 100], invalid: ['x'] });
  });

  it('describes values for the managed view', () => {
    expect(describeValue('')).toBe('(empty)');
    expect(describeValue(['a', 'b'])).toBe('a, b');
    expect(describeValue({ '**/x': true })).toBe('**/x: true');
    expect(describeValue({})).toBe('(none)');
    expect(describeValue(13)).toBe('13');
  });
});

describe('keyboard shortcut rows', () => {
  const resolved = [
    { commandId: 'palette.commands', chord: 'Ctrl+Shift+P', source: 'default' as const },
    { commandId: 'file.save', chord: 'Ctrl+S', source: 'user' as const },
  ];

  it('builds a row per command with its bindings and state', () => {
    const rows = shortcutRows(resolved, [
      { key: 'Ctrl+S', command: 'file.save' },
      { key: 'Ctrl+W', command: '-file.closeEditor' },
    ]);
    const save = rows.find((r) => r.command.id === 'file.save')!;
    expect(save).toMatchObject({ modified: true, unbound: false });
    const close = rows.find((r) => r.command.id === 'file.closeEditor')!;
    expect(close).toMatchObject({ unbound: true, modified: true });
    expect(rows.find((r) => r.command.id === 'palette.commands')?.modified).toBe(false);
  });

  it('searches by title, id, chord and when clause', () => {
    const rows = shortcutRows(
      [
        {
          commandId: 'palette.commands',
          chord: 'Ctrl+Shift+P',
          source: 'default',
          when: 'hasWorkspace',
        },
      ],
      [],
    );
    const row = rows.find((r) => r.command.id === 'palette.commands')!;
    for (const q of ['show all', 'palette.com', 'ctrl+shift+p', 'ctrlshiftp', 'hasworkspace'])
      expect(matchesShortcut(row, q, 'win32'), q).toBe(true);
    expect(matchesShortcut(row, 'zzz', 'win32')).toBe(false);
    expect(commandTitle(row.command)).toBe('View: Show all commands');
  });

  it('names the other commands that use a chord', () => {
    expect(conflictsFor('Ctrl+S', 'file.saveAs', resolved)).toEqual(['File: Save']);
    expect(conflictsFor('Ctrl+S', 'file.save', resolved)).toEqual([]);
  });
});

describe('editing keybindings.json', () => {
  const sample =
    '// my shortcuts\n[\n  // keep this\n  { "key": "Ctrl+K A", "command": "file.save" },\n  { "key": "Ctrl+B", "command": "view.toggleSidebar" }\n]\n';

  it('parses entries, comments and trailing commas, and reports syntax errors', () => {
    expect(parseKeybindingsFile(sample).entries).toHaveLength(2);
    expect(parseKeybindingsFile('[ {"key":"a","command":"b"}, ]').errors).toEqual([]);
    expect(parseKeybindingsFile('[ {').errors.length).toBeGreaterThan(0);
    expect(parseKeybindingsFile('{ "key": 1 }').isArray).toBe(false);
    expect(parseKeybindingsFile('').entries).toEqual([]);
  });

  it('adds an entry without disturbing comments', () => {
    const next = addEntry(sample, { key: 'Ctrl+J', command: 'view.toggleBottomPanel' });
    expect(next).toContain('// my shortcuts');
    expect(next).toContain('// keep this');
    expect(parseKeybindingsFile(next).entries.map((e) => e.command)).toEqual([
      'file.save',
      'view.toggleSidebar',
      'view.toggleBottomPanel',
    ]);
  });

  it('creates the array in an empty file', () => {
    const next = addEntry('', { key: 'Ctrl+J', command: 'x.y' });
    expect(parseKeybindingsFile(next).entries).toEqual([{ key: 'Ctrl+J', command: 'x.y' }]);
  });

  it('removes only matching entries', () => {
    const next = removeEntries(sample, (e) => e.command === 'file.save');
    expect(next).toContain('// keep this');
    expect(parseKeybindingsFile(next).entries.map((e) => e.command)).toEqual([
      'view.toggleSidebar',
    ]);
    expect(removeEntries(sample, () => false)).toBe(sample);
    expect(removeEntries('{ "not": "an array" }', () => true)).toBe('{ "not": "an array" }');
  });

  it('sets a binding: replaces earlier entries and switches the default off', () => {
    const start = addEntry('', { key: 'Ctrl+Q', command: 'file.save' });
    const next = setBinding(start, 'file.save', 'Ctrl+Shift+S', ['Ctrl+S']);
    expect(parseKeybindingsFile(next).entries).toEqual([
      { key: 'Ctrl+S', command: '-file.save' },
      { key: 'Ctrl+Shift+S', command: 'file.save' },
    ]);
    // Doing it again does not pile up entries.
    expect(
      parseKeybindingsFile(setBinding(next, 'file.save', 'Ctrl+Alt+S', ['Ctrl+S'])).entries,
    ).toHaveLength(2);
  });

  it('removes a binding and resets to the default', () => {
    const removed = removeBinding('', 'file.save', ['Ctrl+S']);
    expect(parseKeybindingsFile(removed).entries).toEqual([
      { key: 'Ctrl+S', command: '-file.save' },
    ]);
    expect(parseKeybindingsFile(resetBinding(removed, 'file.save')).entries).toEqual([]);
  });
});
