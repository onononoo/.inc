import { describe, expect, it } from 'vitest';
import type { SettingsSnapshot } from '@shared/api/settings';
import { EMPTY_POLICY, type PolicyState } from '@shared/policy';
import { SETTINGS, defaultSettings } from '@shared/settings';
import {
  changedKeys,
  parseSettingsFile,
  resolveSettings,
} from '../../../src/main/settings/layers';
import { parsePolicy } from '../../../src/main/settings/policy-service';

const USER = '/u/settings.json';
const WS = '/w/.inc/settings.json';

function resolve(
  user: string | null,
  workspace: string | null = null,
  options: { trusted?: boolean; policy?: PolicyState } = {},
): SettingsSnapshot {
  const u = parseSettingsFile(user, USER);
  const w = workspace === null ? null : parseSettingsFile(workspace, WS);
  return resolveSettings({
    user: { file: USER, entries: u.entries, issues: u.issues },
    workspace: w ? { file: WS, entries: w.entries, issues: w.issues } : null,
    trusted: options.trusted ?? true,
    policy: options.policy ?? EMPTY_POLICY,
    workspaceFile: w ? WS : null,
  });
}

function policyOf(document: object): PolicyState {
  return parsePolicy(JSON.stringify({ version: 1, ...document }), '/p/policy.json').state;
}

describe('parseSettingsFile', () => {
  it('treats a missing file as empty', () => {
    const parsed = parseSettingsFile(null, USER);
    expect(parsed.entries.size).toBe(0);
    expect(parsed.syntaxError).toBe(false);
  });

  it('treats a blank or comment-only file as empty without issues', () => {
    expect(parseSettingsFile('', USER).issues).toEqual([]);
    expect(parseSettingsFile('// nothing\n', USER).issues).toEqual([]);
  });

  it('reads comments and trailing commas', () => {
    const parsed = parseSettingsFile('{\n  // size\n  "editor.fontSize": 15,\n}\n', USER);
    expect(parsed.entries.get('editor.fontSize')?.value).toBe(15);
    expect(parsed.entries.get('editor.fontSize')?.line).toBe(3);
    expect(parsed.issues).toEqual([]);
  });

  it('flags a syntax error and keeps no entries', () => {
    const parsed = parseSettingsFile('{ "editor.fontSize": }', USER);
    expect(parsed.syntaxError).toBe(true);
    expect(parsed.issues[0]).toMatchObject({ file: USER });
    expect(parsed.issues[0]?.message).toContain('previous settings stay in effect');
  });

  it('flags a top-level value that is not an object', () => {
    const parsed = parseSettingsFile('[1, 2]', USER);
    expect(parsed.syntaxError).toBe(true);
    expect(parsed.issues[0]?.message).toContain('single object');
  });

  it('reports duplicate keys and uses the last value', () => {
    const parsed = parseSettingsFile('{ "editor.tabSize": 2,\n "editor.tabSize": 8 }', USER);
    expect(parsed.entries.get('editor.tabSize')?.value).toBe(8);
    expect(parsed.issues).toHaveLength(1);
    expect(parsed.issues[0]).toMatchObject({ key: 'editor.tabSize', line: 2 });
  });
});

describe('layering and precedence', () => {
  it('uses defaults when nothing is set', () => {
    const snapshot = resolve(null);
    expect(snapshot.effective).toEqual(defaultSettings());
    expect(Object.values(snapshot.sources).every((s) => s === 'default')).toBe(true);
    expect(snapshot.files).toEqual({ user: USER, workspace: null, policy: null });
  });

  it('user overrides defaults, workspace overrides user, policy overrides everything', () => {
    const user = '{ "editor.tabSize": 3, "editor.wordWrap": "on", "editor.fontSize": 18 }';
    const workspace = '{ "editor.tabSize": 8, "editor.wordWrap": "bounded", "editor.fontSize": 9 }';
    const policy = policyOf({ settings: { 'editor.wordWrap': 'off' } });
    const snapshot = resolve(user, workspace, { policy });

    expect(snapshot.effective['editor.tabSize']).toBe(8);
    expect(snapshot.sources['editor.tabSize']).toBe('workspace');
    expect(snapshot.effective['editor.wordWrap']).toBe('off');
    expect(snapshot.sources['editor.wordWrap']).toBe('policy');
    // fontSize is user-scope only: the workspace value is ignored with an issue.
    expect(snapshot.effective['editor.fontSize']).toBe(18);
    expect(snapshot.sources['editor.fontSize']).toBe('user');
    expect(snapshot.locked).toEqual(['editor.wordWrap']);
    expect(snapshot.user['editor.tabSize']).toBe(3);
    expect(snapshot.workspace['editor.tabSize']).toBe(8);
  });

  it('applies a policy value even when the user and workspace set nothing', () => {
    const policy = policyOf({ settings: { 'appearance.theme': 'dark' } });
    const snapshot = resolve(null, null, { policy });
    expect(snapshot.effective['appearance.theme']).toBe('dark');
    expect(snapshot.sources['appearance.theme']).toBe('policy');
    expect(snapshot.files.policy).toBe('/p/policy.json');
  });

  it('records the workspace file path even when the file does not exist', () => {
    expect(resolve(null, null).files.workspace).toBeNull();
    expect(resolve(null, '').files.workspace).toBe(WS);
  });
});

describe('record settings', () => {
  it('merges key by key across layers and lets later layers turn entries off', () => {
    const user = '{ "files.exclude": { "**/tmp": true, "**/.git": false } }';
    const workspace = '{ "files.exclude": { "**/dist": true } }';
    const snapshot = resolve(user, workspace);
    const exclude = snapshot.effective['files.exclude'];
    expect(exclude['**/tmp']).toBe(true);
    expect(exclude['**/dist']).toBe(true);
    expect(exclude['**/.git']).toBe(false);
    // Defaults the layers did not mention are kept.
    expect(exclude['**/.DS_Store']).toBe(true);
    expect(snapshot.sources['files.exclude']).toBe('workspace');
  });

  it('does not let a workspace shadow keys with prototype names', () => {
    const snapshot = resolve(null, '{ "files.exclude": { "__proto__": true, "constructor": true } }');
    const exclude = snapshot.effective['files.exclude'];
    expect(Object.getPrototypeOf(exclude)).toBe(Object.prototype);
    expect(Object.keys(exclude)).toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('replaces a record entirely when policy enforces it', () => {
    const policy = policyOf({ settings: { 'files.exclude': { '**/secret': true } } });
    const snapshot = resolve('{ "files.exclude": { "**/mine": true } }', null, { policy });
    expect(snapshot.effective['files.exclude']).toEqual({ '**/secret': true });
  });

  it('does not merge list settings', () => {
    const snapshot = resolve('{ "editor.rulers": [80] }', '{ "editor.rulers": [100, 120] }');
    expect(snapshot.effective['editor.rulers']).toEqual([100, 120]);
  });

  it('does not share mutable values between the snapshot and the defaults', () => {
    const snapshot = resolve(null);
    (snapshot.effective['files.exclude'] as Record<string, boolean>)['**/x'] = true;
    expect(SETTINGS['files.exclude'].default).not.toHaveProperty('**/x');
  });
});

describe('invalid and unknown entries', () => {
  it('reports unknown keys and never applies them', () => {
    const snapshot = resolve('{ "editor.fontSizee": 14 }');
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]).toMatchObject({ file: USER, key: 'editor.fontSizee', line: 1 });
    expect(snapshot.issues[0]?.message).toContain('Unknown setting');
    expect(snapshot.effective).toEqual(defaultSettings());
  });

  it.each([
    ['editor.fontSize', '"large"'],
    ['editor.fontSize', '4'],
    ['editor.fontSize', '99'],
    ['editor.wordWrap', '"sideways"'],
    ['editor.rulers', '["80"]'],
    ['files.exclude', '{ "a": "yes" }'],
    ['terminal.env', '{ "A": 1 }'],
    ['editor.minimap', '"false"'],
  ])('ignores an invalid value for %s = %s', (key, raw) => {
    const snapshot = resolve(`{ "${key}": ${raw} }`);
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.issues[0]?.message).toContain('It was ignored');
    expect(snapshot.sources[key as keyof typeof snapshot.sources]).toBe('default');
    expect(snapshot.effective).toEqual(defaultSettings());
  });

  it('keeps valid entries when others in the same file are invalid', () => {
    const snapshot = resolve('{ "editor.fontSize": "x", "editor.tabSize": 6 }');
    expect(snapshot.effective['editor.tabSize']).toBe(6);
    expect(snapshot.effective['editor.fontSize']).toBe(13);
    expect(snapshot.issues).toHaveLength(1);
  });

  it('puts the workspace file name on workspace issues', () => {
    const snapshot = resolve(null, '{ "nope": 1 }');
    expect(snapshot.issues[0]?.file).toBe(WS);
  });

  it('does not let a syntax error erase issue reporting for the other layer', () => {
    const snapshot = resolve('{ "nope": 1 }', '{ "editor.tabSize": }');
    expect(snapshot.issues.map((i) => i.file).sort()).toEqual([USER, WS]);
  });
});

describe('scope and restricted settings', () => {
  it('ignores workspace values for user-scope settings and says so', () => {
    const snapshot = resolve(null, '{ "appearance.theme": "dark", "editor.tabSize": 4 }');
    expect(snapshot.effective['appearance.theme']).toBe('system');
    expect(snapshot.effective['editor.tabSize']).toBe(4);
    const issue = snapshot.issues.find((i) => i.key === 'appearance.theme');
    expect(issue?.file).toBe(WS);
    expect(issue?.message).toContain('user settings');
  });

  it('ignores restricted workspace settings in an untrusted workspace and lists them', () => {
    const workspace = '{ "search.followSymlinks": true, "editor.tabSize": 4 }';
    const untrusted = resolve(null, workspace, { trusted: false });
    expect(untrusted.effective['search.followSymlinks']).toBe(false);
    expect(untrusted.effective['editor.tabSize']).toBe(4);
    expect(untrusted.restrictedIgnored).toEqual(['search.followSymlinks']);
    expect(untrusted.issues).toEqual([]);

    const trusted = resolve(null, workspace, { trusted: true });
    expect(trusted.effective['search.followSymlinks']).toBe(true);
    expect(trusted.restrictedIgnored).toEqual([]);
  });

  it('applies restricted settings from the user file regardless of trust', () => {
    const snapshot = resolve('{ "terminal.shell": "/bin/zsh" }', null, { trusted: false });
    expect(snapshot.effective['terminal.shell']).toBe('/bin/zsh');
    expect(snapshot.restrictedIgnored).toEqual([]);
  });

  it('still reports invalid restricted values instead of silently dropping them', () => {
    const snapshot = resolve(null, '{ "search.followSymlinks": "yes" }', { trusted: false });
    expect(snapshot.issues).toHaveLength(1);
    expect(snapshot.restrictedIgnored).toEqual([]);
  });
});

describe('changedKeys', () => {
  it('lists keys whose value or source changed', () => {
    const before = resolve('{ "editor.tabSize": 4 }');
    const after = resolve('{ "editor.tabSize": 6, "editor.minimap": false }');
    expect(changedKeys(before, after).sort()).toEqual(['editor.minimap', 'editor.tabSize']);
    expect(changedKeys(before, before)).toEqual([]);
  });

  it('reports a source change even when the value stays the same', () => {
    const before = resolve(null);
    const after = resolve('{ "editor.tabSize": 2 }');
    expect(changedKeys(before, after)).toEqual(['editor.tabSize']);
  });
});
