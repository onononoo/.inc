import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SettingsSnapshot } from '@shared/api/settings';
import { defaultSettings, type SettingKey } from '@shared/settings';
import { createDefaultWorkspaceHost } from '../../../src/main/kernel';
import { SettingsService } from '../../../src/main/settings/settings-service';
import {
  USER_SETTINGS_TEMPLATE,
  WORKSPACE_SETTINGS_TEMPLATE,
} from '../../../src/main/settings/templates';
import { codeOf, fakePolicy, recordingLogger, tempDir, waitFor } from './helpers';

const WIN = 1;
const OTHER = 2;

function setup(options: { policy?: object; watch?: boolean; user?: string } = {}) {
  const userData = tempDir('inc-svc-');
  const userFile = path.join(userData, 'settings.json');
  if (options.user !== undefined) writeFileSync(userFile, options.user);
  const workspaces = createDefaultWorkspaceHost();
  const policy = fakePolicy(options.policy ?? null);
  const logger = recordingLogger();
  const notifications: { windowId: number; snapshot: SettingsSnapshot }[] = [];
  const events: { windowId: number | null; keys: SettingKey[] }[] = [];
  const service = new SettingsService({
    userDataDir: userData,
    logger,
    workspaces: () => workspaces,
    policy,
    notify: (windowId, snapshot) => void notifications.push({ windowId, snapshot }),
    watch: options.watch ?? false,
    debounceMs: 20,
  });
  service.onDidChange((e) => events.push(e));
  const folder = (name = 'ws') => {
    const root = path.join(tempDir('inc-root-'), name);
    mkdirSync(root, { recursive: true });
    return root;
  };
  const wsFile = (root: string) => path.join(root, '.inc', 'settings.json');
  return {
    userData,
    userFile,
    workspaces,
    policy,
    logger,
    notifications,
    events,
    service,
    folder,
    wsFile,
  };
}

describe('reading', () => {
  it('returns defaults with no files and records the file locations', () => {
    const { service, userFile } = setup();
    const snapshot = service.snapshot(WIN);
    expect(snapshot.effective).toEqual(defaultSettings());
    expect(snapshot.files).toEqual({ user: userFile, workspace: null, policy: null });
    expect(service.get(WIN, 'editor.fontSize')).toBe(13);
    expect(service.get(null, 'editor.tabSize')).toBe(2);
  });

  it('reads the user file at startup, with comments and trailing commas', () => {
    const { service } = setup({
      user: '// mine\n{\n  "editor.fontSize": 17, // bigger\n  "files.exclude": { "**/out": true },\n}\n',
    });
    expect(service.get(WIN, 'editor.fontSize')).toBe(17);
    expect(service.get(WIN, 'files.exclude')['**/out']).toBe(true);
    expect(service.get(WIN, 'files.exclude')['**/.git']).toBe(true);
  });

  it('reports invalid entries as issues and logs them once', () => {
    const { service, logger } = setup({ user: '{ "editor.fontSize": "big", "nope": 1 }' });
    expect(service.snapshot(WIN).issues).toHaveLength(2);
    service.snapshot(WIN);
    service.reloadUser();
    expect(logger.warnings.filter((w) => w.includes('Settings:'))).toHaveLength(2);
  });

  it('hands out values that callers can change without affecting the service', () => {
    const { service } = setup();
    const exclude = service.get(WIN, 'files.exclude');
    exclude['**/mutated'] = true;
    expect(service.get(WIN, 'files.exclude')).not.toHaveProperty('**/mutated');
    expect(Object.isFrozen(service.snapshot(WIN))).toBe(true);
  });

  it('applies the workspace layer for a window with a folder open', () => {
    const { service, workspaces, folder, wsFile } = setup({ user: '{ "editor.tabSize": 3 }' });
    const root = folder();
    mkdirSync(path.dirname(wsFile(root)), { recursive: true });
    writeFileSync(wsFile(root), '{ "editor.tabSize": 8, "appearance.theme": "dark" }');
    workspaces.setRoot(WIN, root);

    expect(service.get(WIN, 'editor.tabSize')).toBe(8);
    expect(service.snapshot(WIN).sources['editor.tabSize']).toBe('workspace');
    expect(service.snapshot(WIN).files.workspace).toBe(wsFile(root));
    // user-scope setting from the workspace file: ignored with an issue
    expect(service.get(WIN, 'appearance.theme')).toBe('system');
    expect(service.snapshot(WIN).issues.some((i) => i.key === 'appearance.theme')).toBe(true);
    // another window without a folder only sees the user layer
    expect(service.get(OTHER, 'editor.tabSize')).toBe(3);
    expect(service.get(null, 'editor.tabSize')).toBe(3);
  });

  it('ignores restricted workspace settings until the workspace is trusted', () => {
    const { service, workspaces, folder, wsFile, notifications, events } = setup();
    const root = folder();
    mkdirSync(path.dirname(wsFile(root)), { recursive: true });
    writeFileSync(wsFile(root), '{ "search.followSymlinks": true }');
    workspaces.setRoot(WIN, root);
    workspaces.setTrusted(WIN, false);

    let snapshot = service.snapshot(WIN);
    expect(snapshot.effective['search.followSymlinks']).toBe(false);
    expect(snapshot.restrictedIgnored).toEqual(['search.followSymlinks']);

    notifications.length = 0;
    events.length = 0;
    workspaces.setTrusted(WIN, true);
    snapshot = service.snapshot(WIN);
    expect(snapshot.effective['search.followSymlinks']).toBe(true);
    expect(snapshot.restrictedIgnored).toEqual([]);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.windowId).toBe(WIN);
    expect(events).toEqual([{ windowId: WIN, keys: ['search.followSymlinks'] }]);

    workspaces.setTrusted(WIN, false);
    expect(service.get(WIN, 'search.followSymlinks')).toBe(false);
  });

  it('re-evaluates when the window opens another folder or closes it', () => {
    const { service, workspaces, folder, wsFile, notifications, events } = setup();
    const a = folder('a');
    const b = folder('b');
    for (const [root, size] of [
      [a, 3],
      [b, 6],
    ] as const) {
      mkdirSync(path.dirname(wsFile(root)), { recursive: true });
      writeFileSync(wsFile(root), `{ "editor.tabSize": ${size} }`);
    }
    expect(service.get(WIN, 'editor.tabSize')).toBe(2);
    workspaces.setRoot(WIN, a);
    expect(service.get(WIN, 'editor.tabSize')).toBe(3);
    expect(notifications.at(-1)?.snapshot.effective['editor.tabSize']).toBe(3);
    workspaces.setRoot(WIN, b);
    expect(service.get(WIN, 'editor.tabSize')).toBe(6);
    workspaces.setRoot(WIN, null);
    expect(service.get(WIN, 'editor.tabSize')).toBe(2);
    expect(service.snapshot(WIN).files.workspace).toBeNull();
    // Every root change was announced to that window only.
    expect(events.every((e) => e.windowId === WIN)).toBe(true);
    expect(events.map((e) => e.keys)).toEqual([
      ['editor.tabSize'],
      ['editor.tabSize'],
      ['editor.tabSize'],
    ]);
  });

  it('keeps following the workspace host after the workspace slice replaces it', () => {
    const userData = tempDir('inc-svc-');
    const first = createDefaultWorkspaceHost();
    const second = createDefaultWorkspaceHost();
    let current = first;
    const notifications: number[] = [];
    const service = new SettingsService({
      userDataDir: userData,
      logger: recordingLogger(),
      workspaces: () => current,
      policy: fakePolicy(),
      notify: (windowId) => void notifications.push(windowId),
      watch: false,
    });
    service.snapshot(WIN);
    current = second;
    service.attach();

    const root = path.join(tempDir('inc-root-'), 'ws');
    mkdirSync(path.join(root, '.inc'), { recursive: true });
    writeFileSync(path.join(root, '.inc', 'settings.json'), '{ "editor.tabSize": 5 }');
    second.setRoot(WIN, root);
    expect(service.get(WIN, 'editor.tabSize')).toBe(5);
    expect(notifications).toEqual([WIN]);
    // Events from the replaced host no longer matter.
    first.setRoot(WIN, null);
    expect(notifications).toEqual([WIN]);
  });
});

describe('policy', () => {
  it('overrides every other layer and reports the locked keys and the policy file', () => {
    const { service, workspaces, folder, wsFile } = setup({
      policy: { version: 1, settings: { 'editor.tabSize': 4, 'appearance.theme': 'light' } },
      user: '{ "editor.tabSize": 2, "appearance.theme": "dark" }',
    });
    const root = folder();
    mkdirSync(path.dirname(wsFile(root)), { recursive: true });
    writeFileSync(wsFile(root), '{ "editor.tabSize": 8 }');
    workspaces.setRoot(WIN, root);
    const snapshot = service.snapshot(WIN);
    expect(snapshot.effective['editor.tabSize']).toBe(4);
    expect(snapshot.effective['appearance.theme']).toBe('light');
    expect(snapshot.sources['editor.tabSize']).toBe('policy');
    expect(snapshot.locked).toEqual(['appearance.theme', 'editor.tabSize']);
    expect(snapshot.files.policy).toBe('policy.json');
  });

  it('applies a policy that changes while running and tells every window', () => {
    const { service, policy, notifications, events } = setup();
    service.snapshot(WIN);
    service.snapshot(OTHER);
    service.snapshot(null);
    notifications.length = 0;
    policy.load({ version: 1, settings: { 'editor.minimap': false } });
    expect(service.get(WIN, 'editor.minimap')).toBe(false);
    expect(notifications.map((n) => n.windowId).sort()).toEqual([WIN, OTHER]);
    expect(events).toEqual([{ windowId: null, keys: ['editor.minimap'] }]);

    // A change that only touches features still reaches the windows, but moves no setting.
    notifications.length = 0;
    events.length = 0;
    policy.load({
      version: 1,
      settings: { 'editor.minimap': false },
      features: { terminal: false },
    });
    expect(notifications).toHaveLength(2);
    expect(events).toEqual([]);
  });

  it('lets a lifted policy return control to the user value', () => {
    const { service, policy } = setup({
      policy: { version: 1, settings: { 'editor.tabSize': 4 } },
      user: '{ "editor.tabSize": 6 }',
    });
    expect(service.get(WIN, 'editor.tabSize')).toBe(4);
    policy.load(null);
    expect(service.get(WIN, 'editor.tabSize')).toBe(6);
  });

  it('enforces workspace trust from policy like any other setting', () => {
    const { service } = setup({
      policy: { version: 1, settings: { 'security.workspaceTrust': true } },
      user: '{ "security.workspaceTrust": false }',
    });
    expect(service.get(null, 'security.workspaceTrust')).toBe(true);
  });
});

describe('writing', () => {
  it('creates the user file with the header on the first set', async () => {
    const { service, userFile, notifications, events } = setup();
    service.snapshot(WIN);
    const snapshot = await service.set(WIN, 'editor.fontSize', 16, 'user');
    expect(snapshot.effective['editor.fontSize']).toBe(16);
    expect(snapshot.sources['editor.fontSize']).toBe('user');
    expect(snapshot.user['editor.fontSize']).toBe(16);
    const text = readFileSync(userFile, 'utf8');
    expect(text.startsWith(USER_SETTINGS_TEMPLATE.split('\n')[0] as string)).toBe(true);
    expect(text).toContain('"editor.fontSize": 16');
    expect(notifications).toHaveLength(1);
    expect(events).toEqual([{ windowId: null, keys: ['editor.fontSize'] }]);
  });

  it('keeps comments, order and trailing commas when setting and resetting', async () => {
    const original = [
      '// my settings',
      '{',
      '  // theme',
      '  "appearance.theme": "dark", // always dark',
      '  "editor.fontSize": 12,',
      '}',
      '',
    ].join('\n');
    const { service, userFile } = setup({ user: original });
    await service.set(WIN, 'editor.fontSize', 20, 'user');
    expect(readFileSync(userFile, 'utf8')).toBe(original.replace('12', '20'));

    await service.set(WIN, 'editor.tabSize', 4, 'user');
    const withTab = readFileSync(userFile, 'utf8');
    expect(withTab).toContain('// theme');
    expect(withTab).toContain('// always dark');
    expect(withTab).toContain('"editor.tabSize": 4');

    const snapshot = await service.reset(WIN, 'editor.tabSize', 'user');
    expect(snapshot.effective['editor.tabSize']).toBe(2);
    expect(readFileSync(userFile, 'utf8')).toBe(original.replace('12', '20'));

    await service.reset(WIN, 'editor.fontSize', 'user');
    expect(readFileSync(userFile, 'utf8')).toBe(
      '// my settings\n{\n  // theme\n  "appearance.theme": "dark", // always dark\n}\n',
    );
  });

  it('keeps a byte order mark and CRLF line endings', async () => {
    const { service, userFile } = setup({ user: '﻿{\r\n  "editor.tabSize": 3\r\n}\r\n' });
    expect(service.get(WIN, 'editor.tabSize')).toBe(3);
    await service.set(WIN, 'editor.fontSize', 15, 'user');
    const text = readFileSync(userFile, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(service.get(WIN, 'editor.fontSize')).toBe(15);
  });

  it('writes record and list values', async () => {
    const { service } = setup();
    await service.set(WIN, 'files.exclude', { '**/dist': true }, 'user');
    await service.set(WIN, 'editor.rulers', [80, 120], 'user');
    expect(service.get(WIN, 'files.exclude')['**/dist']).toBe(true);
    expect(service.get(WIN, 'files.exclude')['**/.git']).toBe(true);
    expect(service.get(WIN, 'editor.rulers')).toEqual([80, 120]);
  });

  it('writes nothing when the value in the file is already right', async () => {
    const { service, userFile, notifications } = setup({ user: '{ "editor.tabSize": 3, }\n' });
    service.snapshot(WIN);
    await service.set(WIN, 'editor.tabSize', 3, 'user');
    expect(readFileSync(userFile, 'utf8')).toBe('{ "editor.tabSize": 3, }\n');
    expect(notifications).toEqual([]);
  });

  it('resetting a key that is not set does not create or change a file', async () => {
    const { service, userFile } = setup();
    await service.reset(WIN, 'editor.tabSize', 'user');
    expect(existsSync(userFile)).toBe(false);
    const withFile = setup({ user: '// keep\n{ "editor.tabSize": 3 }\n' });
    await withFile.service.reset(WIN, 'editor.fontSize', 'user');
    expect(readFileSync(withFile.userFile, 'utf8')).toBe('// keep\n{ "editor.tabSize": 3 }\n');
  });

  it('rejects a locked key with E_POLICY, for set and reset, in either scope', async () => {
    const { service, userFile, workspaces, folder } = setup({
      policy: { version: 1, settings: { 'editor.tabSize': 4 } },
      user: '{ "editor.tabSize": 6 }',
    });
    workspaces.setRoot(WIN, folder());
    expect(await codeOf(service.set(WIN, 'editor.tabSize', 3, 'user'))).toBe('E_POLICY');
    expect(await codeOf(service.set(WIN, 'editor.tabSize', 3, 'workspace'))).toBe('E_POLICY');
    expect(await codeOf(service.reset(WIN, 'editor.tabSize', 'user'))).toBe('E_POLICY');
    expect(readFileSync(userFile, 'utf8')).toBe('{ "editor.tabSize": 6 }');
    // Other keys still work.
    await service.set(WIN, 'editor.fontSize', 14, 'user');
    expect(service.get(WIN, 'editor.fontSize')).toBe(14);
  });

  it('validates the key, scope and value', async () => {
    const { service, userFile } = setup();
    expect(await codeOf(service.set(WIN, 'nope.nothing', 1, 'user'))).toBe('E_INVALID');
    expect(await codeOf(service.set(WIN, 42, 1, 'user'))).toBe('E_INVALID');
    expect(await codeOf(service.set(WIN, 'editor.fontSize', 'big', 'user'))).toBe('E_INVALID');
    expect(await codeOf(service.set(WIN, 'editor.fontSize', 3, 'user'))).toBe('E_INVALID');
    expect(await codeOf(service.set(WIN, 'editor.fontSize', Number.NaN, 'user'))).toBe('E_INVALID');
    expect(await codeOf(service.set(WIN, 'editor.fontSize', undefined, 'user'))).toBe('E_INVALID');
    expect(await codeOf(service.set(WIN, 'editor.fontSize', 14, 'global'))).toBe('E_INVALID');
    expect(await codeOf(service.reset(WIN, 'editor.fontSize', 'both'))).toBe('E_INVALID');
    expect(await codeOf(service.reset(WIN, 'nope', 'user'))).toBe('E_INVALID');
    expect(existsSync(userFile)).toBe(false);
  });

  it('refuses a value that would make the file larger than the 1 MB limit', async () => {
    const { service, userFile } = setup();
    const huge: Record<string, boolean> = {};
    for (let i = 0; i < 40000; i++) huge[`**/some/long/path/segment-${i}/**`] = true;
    expect(await codeOf(service.set(WIN, 'files.exclude', huge, 'user'))).toBe('E_TOO_LARGE');
    expect(existsSync(userFile)).toBe(false);
  });

  it('never edits a file with a syntax error', async () => {
    const broken = '{\n  "editor.tabSize": 3\n  "editor.fontSize": 14\n}\n';
    const { service, userFile } = setup({ user: broken });
    expect(await codeOf(service.set(WIN, 'editor.minimap', false, 'user'))).toBe('E_INVALID');
    expect(await codeOf(service.reset(WIN, 'editor.tabSize', 'user'))).toBe('E_INVALID');
    expect(readFileSync(userFile, 'utf8')).toBe(broken);
    const error = await service.set(WIN, 'editor.minimap', false, 'user').catch((e: Error) => e);
    expect((error as Error).message).toContain('Line 3');
  });

  it('never edits a file whose top level is not an object', async () => {
    const { service, userFile } = setup({ user: '[1, 2]' });
    expect(await codeOf(service.set(WIN, 'editor.minimap', false, 'user'))).toBe('E_INVALID');
    expect(readFileSync(userFile, 'utf8')).toBe('[1, 2]');
  });

  it('leaves no temporary files behind', async () => {
    const { service, userData } = setup();
    for (let i = 0; i < 5; i++) await service.set(WIN, 'editor.tabSize', i + 1, 'user');
    expect(readdirSync(userData)).toEqual(['settings.json']);
  });

  it('serialises concurrent writes so none is lost', async () => {
    const { service, userFile } = setup();
    await Promise.all([
      service.set(WIN, 'editor.tabSize', 4, 'user'),
      service.set(WIN, 'editor.fontSize', 15, 'user'),
      service.set(WIN, 'editor.minimap', false, 'user'),
      service.set(WIN, 'editor.wordWrap', 'on', 'user'),
      service.set(WIN, 'files.autoSave', 'afterDelay', 'user'),
    ]);
    const text = readFileSync(userFile, 'utf8');
    for (const key of [
      'editor.tabSize',
      'editor.fontSize',
      'editor.minimap',
      'editor.wordWrap',
      'files.autoSave',
    ]) {
      expect(text).toContain(`"${key}"`);
    }
    expect(service.snapshot(WIN).issues).toEqual([]);
  });

  it('picks up an edit made on disk between two writes', async () => {
    const { service, userFile } = setup({ user: '{ "editor.tabSize": 3 }' });
    await service.set(WIN, 'editor.fontSize', 14, 'user');
    writeFileSync(userFile, '{ "editor.tabSize": 3, "editor.minimap": false }');
    await service.set(WIN, 'editor.fontSize', 15, 'user');
    expect(readFileSync(userFile, 'utf8')).toContain('"editor.minimap": false');
    expect(service.get(WIN, 'editor.minimap')).toBe(false);
    expect(service.get(WIN, 'editor.fontSize')).toBe(15);
  });

  describe('workspace scope', () => {
    it('writes to <root>/.inc/settings.json and notifies only that window', async () => {
      const { service, workspaces, folder, wsFile, notifications, events } = setup({
        user: '{ "editor.tabSize": 3 }',
      });
      const root = folder();
      workspaces.setRoot(WIN, root);
      service.snapshot(WIN);
      service.snapshot(OTHER);
      notifications.length = 0;
      events.length = 0;

      const snapshot = await service.set(WIN, 'editor.tabSize', 8, 'workspace');
      expect(snapshot.effective['editor.tabSize']).toBe(8);
      expect(snapshot.workspace['editor.tabSize']).toBe(8);
      expect(snapshot.user['editor.tabSize']).toBe(3);
      expect(readFileSync(wsFile(root), 'utf8')).toContain('"editor.tabSize": 8');
      expect(readFileSync(wsFile(root), 'utf8').startsWith('// Workspace settings')).toBe(true);
      expect(notifications.map((n) => n.windowId)).toEqual([WIN]);
      expect(events).toEqual([{ windowId: WIN, keys: ['editor.tabSize'] }]);
      expect(service.get(OTHER, 'editor.tabSize')).toBe(3);

      const reset = await service.reset(WIN, 'editor.tabSize', 'workspace');
      expect(reset.effective['editor.tabSize']).toBe(3);
    });

    it('requires an open folder', async () => {
      const { service } = setup();
      expect(await codeOf(service.set(WIN, 'editor.tabSize', 4, 'workspace'))).toBe(
        'E_NO_WORKSPACE',
      );
      expect(await codeOf(service.ensureFile(WIN, 'workspace'))).toBe('E_NO_WORKSPACE');
    });

    it('refuses settings that can only be set by the user', async () => {
      const { service, workspaces, folder } = setup();
      workspaces.setRoot(WIN, folder());
      expect(await codeOf(service.set(WIN, 'appearance.theme', 'dark', 'workspace'))).toBe(
        'E_INVALID',
      );
    });

    it('refuses restricted settings while the workspace is not trusted', async () => {
      const { service, workspaces, folder, wsFile } = setup();
      const root = folder();
      workspaces.setRoot(WIN, root);
      workspaces.setTrusted(WIN, false);
      expect(await codeOf(service.set(WIN, 'search.followSymlinks', true, 'workspace'))).toBe(
        'E_UNTRUSTED',
      );
      expect(existsSync(wsFile(root))).toBe(false);
      // Ordinary settings and resets are fine in an untrusted workspace.
      await service.set(WIN, 'editor.tabSize', 4, 'workspace');
      expect(service.get(WIN, 'editor.tabSize')).toBe(4);
      workspaces.setTrusted(WIN, true);
      await service.set(WIN, 'search.followSymlinks', true, 'workspace');
      expect(service.get(WIN, 'search.followSymlinks')).toBe(true);
    });

    it('does not write through a .inc folder that is a symbolic link', async (ctx) => {
      const { service, workspaces, folder, wsFile } = setup();
      const root = folder();
      const outside = path.join(tempDir('inc-outside-'), 'target');
      mkdirSync(outside, { recursive: true });
      try {
        symlinkSync(outside, path.join(root, '.inc'), 'junction');
      } catch {
        ctx.skip();
        return;
      }
      workspaces.setRoot(WIN, root);
      expect(await codeOf(service.set(WIN, 'editor.tabSize', 4, 'workspace'))).toBe('E_PERMISSION');
      expect(await codeOf(service.ensureFile(WIN, 'workspace'))).toBe('E_PERMISSION');
      expect(existsSync(path.join(outside, 'settings.json'))).toBe(false);
      expect(wsFile(root)).toContain('.inc');
    });
  });
});

describe('ensureFile', () => {
  it('creates the user file with a header and leaves an existing file alone', async () => {
    const { service, userFile } = setup();
    expect(await service.ensureFile(WIN, 'user')).toBe(userFile);
    expect(readFileSync(userFile, 'utf8')).toBe(USER_SETTINGS_TEMPLATE);
    writeFileSync(userFile, '{ "editor.tabSize": 5 }');
    expect(await service.ensureFile(WIN, 'user')).toBe(userFile);
    expect(readFileSync(userFile, 'utf8')).toBe('{ "editor.tabSize": 5 }');
    expect(service.get(WIN, 'editor.tabSize')).toBe(5);
  });

  it('creates the workspace file inside .inc', async () => {
    const { service, workspaces, folder, wsFile } = setup();
    const root = folder();
    workspaces.setRoot(WIN, root);
    expect(await service.ensureFile(WIN, 'workspace')).toBe(wsFile(root));
    expect(readFileSync(wsFile(root), 'utf8')).toBe(WORKSPACE_SETTINGS_TEMPLATE);
    expect(service.snapshot(WIN).issues).toEqual([]);
  });

  it('rejects an unknown scope', async () => {
    const { service } = setup();
    expect(await codeOf(service.ensureFile(WIN, 'machine'))).toBe('E_INVALID');
  });

  it('creates files that parse cleanly', async () => {
    const { service, workspaces, folder } = setup();
    workspaces.setRoot(WIN, folder());
    await service.ensureFile(WIN, 'user');
    await service.ensureFile(WIN, 'workspace');
    expect(service.snapshot(WIN).issues).toEqual([]);
  });
});

describe('live file watching', () => {
  it('applies edits made by another program and notifies every window', async () => {
    const { service, userFile, notifications, events } = setup({ watch: true });
    try {
      service.snapshot(WIN);
      service.snapshot(OTHER);
      notifications.length = 0;
      writeFileSync(userFile, '{ "editor.tabSize": 7 }');
      await waitFor(() => notifications.length >= 2, 'settings change notifications');
      expect(new Set(notifications.map((n) => n.windowId))).toEqual(new Set([WIN, OTHER]));
      expect(service.get(WIN, 'editor.tabSize')).toBe(7);
      expect(events).toEqual([{ windowId: null, keys: ['editor.tabSize'] }]);
    } finally {
      service.dispose();
    }
  });

  it('handles saves that replace the file (temp file + rename) and deletion', async () => {
    const { service, userFile, userData, notifications } = setup({
      watch: true,
      user: '{ "editor.tabSize": 3 }',
    });
    try {
      service.snapshot(WIN);
      notifications.length = 0;
      const temp = path.join(userData, 'editor.tmp');
      writeFileSync(temp, '{ "editor.tabSize": 9 }');
      renameSync(temp, userFile);
      await waitFor(() => service.get(WIN, 'editor.tabSize') === 9, 'atomic replace');

      rmSync(userFile);
      await waitFor(() => service.get(WIN, 'editor.tabSize') === 2, 'deletion');

      writeFileSync(userFile, '{ "editor.tabSize": 5 }');
      await waitFor(() => service.get(WIN, 'editor.tabSize') === 5, 're-creation');
      expect(notifications.length).toBeGreaterThanOrEqual(3);
    } finally {
      service.dispose();
    }
  });

  it('keeps the last good settings while the file has a syntax error, and recovers', async () => {
    const { service, userFile, notifications } = setup({
      watch: true,
      user: '{ "editor.tabSize": 3 }',
    });
    try {
      service.snapshot(WIN);
      notifications.length = 0;
      writeFileSync(userFile, '{ "editor.tabSize": ');
      await waitFor(() => notifications.length > 0, 'syntax error report');
      const broken = service.snapshot(WIN);
      expect(broken.effective['editor.tabSize']).toBe(3);
      expect(broken.issues[0]?.message).toContain('previous settings stay in effect');

      writeFileSync(userFile, '{ "editor.tabSize": 4 }');
      await waitFor(() => service.get(WIN, 'editor.tabSize') === 4, 'recovery');
      expect(service.snapshot(WIN).issues).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it('does not report its own writes twice', async () => {
    const { service, notifications } = setup({ watch: true });
    try {
      service.snapshot(WIN);
      notifications.length = 0;
      await service.set(WIN, 'editor.tabSize', 4, 'user');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(notifications).toHaveLength(1);
    } finally {
      service.dispose();
    }
  });

  it('follows the workspace file of a window and only notifies that window', async () => {
    const { service, workspaces, folder, wsFile, notifications, events } = setup({ watch: true });
    try {
      const root = folder();
      workspaces.setRoot(WIN, root);
      service.snapshot(WIN);
      service.snapshot(OTHER);
      notifications.length = 0;
      events.length = 0;

      // The .inc folder does not exist yet: it is created later by another program.
      mkdirSync(path.dirname(wsFile(root)));
      writeFileSync(wsFile(root), '{ "editor.tabSize": 6 }');
      await waitFor(
        () => service.get(WIN, 'editor.tabSize') === 6,
        'workspace file creation',
        8000,
      );
      expect(notifications.map((n) => n.windowId)).toEqual([WIN]);
      expect(events).toEqual([{ windowId: WIN, keys: ['editor.tabSize'] }]);
      expect(service.get(OTHER, 'editor.tabSize')).toBe(2);
    } finally {
      service.dispose();
    }
  });

  it('stops watching a window that was released', async () => {
    const { service, workspaces, folder, wsFile, notifications } = setup({ watch: true });
    try {
      const root = folder();
      mkdirSync(path.dirname(wsFile(root)), { recursive: true });
      workspaces.setRoot(WIN, root);
      service.snapshot(WIN);
      service.releaseWindow(WIN);
      notifications.length = 0;
      writeFileSync(wsFile(root), '{ "editor.tabSize": 6 }');
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(notifications).toEqual([]);
    } finally {
      service.dispose();
    }
  });
});
