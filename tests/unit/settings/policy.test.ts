import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PolicyState } from '@shared/policy';
import { DEFAULT_POLICY_FEATURES } from '@shared/policy';
import {
  NOTICE_MAX_LENGTH,
  PolicyService,
  RESTRICTIVE_FEATURES,
  defaultPolicyPath,
  parsePolicy,
  resolvePolicyPath,
  sanitizeNotice,
} from '../../../src/main/settings/policy-service';
import { recordingLogger, tempDir, waitFor } from './helpers';

const FILE = '/etc/inc/policy.json';
const parse = (text: string) => parsePolicy(text, FILE);

describe('parsePolicy', () => {
  it('reads settings, features and notice from a complete document', () => {
    const { usable, state } = parse(`{
      // Managed by IT
      "version": 1,
      "settings": { "appearance.theme": "dark", "editor.fontSize": 14, },
      "features": { "terminal": false, "externalLinks": "deny" },
      "notice": "Managed by Acme IT. help@acme.example",
    }`);
    expect(usable).toBe(true);
    expect(state.active).toBe(true);
    expect(state.file).toBe(FILE);
    expect(state.lockedKeys).toEqual(['appearance.theme', 'editor.fontSize']);
    expect(state.values).toEqual({ 'appearance.theme': 'dark', 'editor.fontSize': 14 });
    expect(state.features).toEqual({
      ...DEFAULT_POLICY_FEATURES,
      terminal: false,
      externalLinks: 'deny',
    });
    expect(state.notice).toBe('Managed by Acme IT. help@acme.example');
    expect(state.warnings).toEqual([]);
  });

  it('merges features over the defaults', () => {
    const { state } = parse('{ "version": 1 }');
    expect(state.active).toBe(true);
    expect(state.features).toEqual(DEFAULT_POLICY_FEATURES);
    expect(state.lockedKeys).toEqual([]);
    expect(state.notice).toBeNull();
  });

  it('orders locked keys by the settings schema, not by the file', () => {
    const { state } = parse(
      '{ "version": 1, "settings": { "security.workspaceTrust": true, "appearance.theme": "dark" } }',
    );
    expect(state.lockedKeys).toEqual(['appearance.theme', 'security.workspaceTrust']);
  });

  it('can enforce workspace trust like any other setting', () => {
    const { state } = parse('{ "version": 1, "settings": { "security.workspaceTrust": true } }');
    expect(state.lockedKeys).toEqual(['security.workspaceTrust']);
    expect(state.values['security.workspaceTrust']).toBe(true);
  });

  it('ignores invalid and unknown settings with a warning each', () => {
    const { state } = parse(`{
      "version": 1,
      "settings": {
        "editor.fontSize": "big",
        "editor.fontSizee": 12,
        "editor.tabSize": 3
      }
    }`);
    expect(state.lockedKeys).toEqual(['editor.tabSize']);
    expect(state.values).toEqual({ 'editor.tabSize': 3 });
    expect(state.warnings).toHaveLength(2);
    expect(state.warnings.join('\n')).toContain('editor.fontSize');
    expect(state.warnings.join('\n')).toContain('editor.fontSizee');
  });

  it('warns about unknown top-level fields and unknown or invalid features', () => {
    const { state } = parse(`{
      "version": 1,
      "extra": true,
      "features": { "terminal": "no", "teleport": true, "externalLinks": "sometimes", "tasks": false }
    }`);
    expect(state.features).toEqual({ ...DEFAULT_POLICY_FEATURES, tasks: false });
    expect(state.warnings).toHaveLength(4);
    expect(state.warnings.join('\n')).toContain('"extra"');
    expect(state.warnings.join('\n')).toContain('"teleport"');
  });

  it('warns when settings, features or notice have the wrong shape', () => {
    const { state } = parse('{ "version": 1, "settings": [1], "features": 3, "notice": 7 }');
    expect(state.warnings).toHaveLength(3);
    expect(state.lockedKeys).toEqual([]);
    expect(state.notice).toBeNull();
  });

  it('treats a file with another version as inactive and says so', () => {
    for (const text of ['{ "version": 2, "settings": { "editor.fontSize": 20 } }', '{ }']) {
      const { usable, state } = parse(text);
      expect(usable).toBe(true);
      expect(state.active).toBe(false);
      expect(state.lockedKeys).toEqual([]);
      expect(state.features).toEqual(DEFAULT_POLICY_FEATURES);
      expect(state.warnings).toHaveLength(1);
      expect(state.warnings[0]).toContain('version');
    }
  });

  it.each([
    ['empty', ''],
    ['comment only', '// nothing\n'],
    ['syntax error', '{ "version": 1, '],
    ['not an object', '[1]'],
    ['a number', '42'],
  ])('is unusable when the file is %s', (_name, text) => {
    const result = parse(text);
    expect(result.usable).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(result.state.features).toEqual(RESTRICTIVE_FEATURES);
  });

  it('never keeps prototype-polluting keys', () => {
    const { state } = parse('{ "version": 1, "settings": { "__proto__": { "x": 1 } } }');
    expect(state.lockedKeys).toEqual([]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('does not let invalid values through for record settings', () => {
    const { state } = parse('{ "version": 1, "settings": { "files.exclude": { "a": "yes" } } }');
    expect(state.lockedKeys).toEqual([]);
    expect(state.warnings).toHaveLength(1);
  });
});

describe('sanitizeNotice', () => {
  it('keeps plain text unchanged', () => {
    expect(sanitizeNotice('Managed by Acme IT. help@acme.example')).toBe(
      'Managed by Acme IT. help@acme.example',
    );
  });

  it('removes markup, control characters and bidirectional overrides', () => {
    expect(sanitizeNotice('Call <b>IT</b> now<script>x()</script>')).toBe('Call IT now x()');
    expect(sanitizeNotice('a\u0000b\u0007c\u202Ed\u2066e\u200Bf')).toBe('a b c d e f');
  });

  it('collapses whitespace and line breaks', () => {
    expect(sanitizeNotice('  one\n\n two\t three  ')).toBe('one two three');
  });

  it('limits the length to 500 characters', () => {
    const out = sanitizeNotice('x'.repeat(2000));
    expect(Array.from(out)).toHaveLength(NOTICE_MAX_LENGTH);
    expect(out.endsWith('\u2026')).toBe(true);
    expect(sanitizeNotice('y'.repeat(NOTICE_MAX_LENGTH))).toHaveLength(NOTICE_MAX_LENGTH);
  });

  it('counts characters, not UTF-16 units', () => {
    const out = sanitizeNotice('\u{1F512}'.repeat(600));
    expect(Array.from(out)).toHaveLength(NOTICE_MAX_LENGTH);
  });

  it('reports a notice that is empty after cleaning as absent', () => {
    expect(parse('{ "version": 1, "notice": "  <br>  " }').state.notice).toBeNull();
  });
});

describe('policy file location', () => {
  it('uses the platform default location', () => {
    expect(defaultPolicyPath('win32', { ProgramData: 'D:\\PD' })).toBe('D:\\PD\\.inc\\policy.json');
    expect(defaultPolicyPath('win32', {})).toBe('C:\\ProgramData\\.inc\\policy.json');
    expect(defaultPolicyPath('darwin', {})).toBe('/Library/Application Support/.inc/policy.json');
    expect(defaultPolicyPath('linux', {})).toBe('/etc/inc/policy.json');
  });

  it('honours INC_POLICY_FILE in development builds', () => {
    const result = resolvePolicyPath({
      platform: 'linux',
      env: { INC_POLICY_FILE: '/tmp/test-policy.json' },
      isPackaged: false,
    });
    expect(result).toEqual({ file: '/tmp/test-policy.json', source: 'environment' });
  });

  it('ignores INC_POLICY_FILE in installed builds, where users control the environment', () => {
    const result = resolvePolicyPath({
      platform: 'linux',
      env: { INC_POLICY_FILE: '/tmp/test-policy.json' },
      isPackaged: true,
    });
    expect(result.file).toBe('/etc/inc/policy.json');
    expect(result.source).toBe('default');
    expect(result.ignoredOverride).toBe('/tmp/test-policy.json');
  });

  it('treats a blank INC_POLICY_FILE as unset', () => {
    const result = resolvePolicyPath({
      platform: 'darwin',
      env: { INC_POLICY_FILE: '  ' },
      isPackaged: true,
    });
    expect(result).toEqual({
      file: '/Library/Application Support/.inc/policy.json',
      source: 'default',
    });
  });
});

describe('PolicyService', () => {
  function setup(initial?: string, watch = false) {
    const dir = tempDir('inc-policy-');
    const file = path.join(dir, 'policy.json');
    if (initial !== undefined) writeFileSync(file, initial);
    const logger = recordingLogger();
    const service = new PolicyService({ file, logger, watch, debounceMs: 20 });
    const states: PolicyState[] = [];
    service.onDidChange((s) => states.push(s));
    return { dir, file, logger, service, states };
  }

  const GOOD =
    '{ "version": 1, "settings": { "editor.fontSize": 14 }, "features": { "terminal": false } }';

  it('behaves as if no policy exists when the file is missing', () => {
    const { service, file } = setup();
    expect(service.state.active).toBe(false);
    expect(service.state.file).toBeNull();
    expect(service.state.features).toEqual(DEFAULT_POLICY_FEATURES);
    expect(service.state.warnings).toEqual([]);
    expect(service.file).toBe(file);
  });

  it('loads a valid policy at startup', () => {
    const { service, file } = setup(GOOD);
    expect(service.state.active).toBe(true);
    expect(service.state.file).toBe(file);
    expect(service.state.lockedKeys).toEqual(['editor.fontSize']);
    expect(service.state.features.terminal).toBe(false);
  });

  it('applies restrictive defaults at startup when the file cannot be parsed', () => {
    const { service, logger } = setup('{ "version": 1, ');
    const state = service.state;
    expect(state.active).toBe(true);
    expect(state.features).toEqual({
      terminal: false,
      tasks: false,
      gitRemoteOperations: false,
      externalLinks: 'deny',
    });
    expect(state.lockedKeys).toEqual([]);
    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]).toContain('could not be used');
    expect(state.notice).toContain('IT administrator');
    expect(logger.warnings.some((w) => w.includes('Policy:'))).toBe(true);
  });

  it('applies restrictive defaults when the path is a folder rather than a file', () => {
    const dir = tempDir('inc-policy-');
    const file = path.join(dir, 'policy.json');
    mkdirSync(file);
    const service = new PolicyService({ file, logger: recordingLogger(), watch: false });
    expect(service.state.features.terminal).toBe(false);
    expect(service.state.warnings[0]).toContain('not a regular file');
  });

  it('keeps the last good policy when the file later becomes unusable', () => {
    const { service, file, states } = setup(GOOD);
    writeFileSync(file, '{ "version": 1, "settings": { ');
    expect(service.reload()).toBe(true);
    expect(service.state.features.terminal).toBe(false);
    expect(service.state.lockedKeys).toEqual(['editor.fontSize']);
    expect(service.state.warnings[0]).toContain('last valid policy stays in effect');
    expect(states).toHaveLength(1);

    // Fixing the file clears the warning.
    writeFileSync(file, GOOD);
    expect(service.reload()).toBe(true);
    expect(service.state.warnings).toEqual([]);
  });

  it('does not emit when nothing changed', () => {
    const { service, states } = setup(GOOD);
    expect(service.reload()).toBe(false);
    expect(states).toHaveLength(0);
  });

  it('drops the policy when the file is deleted and restores it when it comes back', () => {
    const { service, file, states } = setup(GOOD);
    rmSync(file);
    expect(service.reload()).toBe(true);
    expect(service.state.active).toBe(false);
    expect(service.state.features).toEqual(DEFAULT_POLICY_FEATURES);
    writeFileSync(file, GOOD);
    expect(service.reload()).toBe(true);
    expect(service.state.active).toBe(true);
    expect(states).toHaveLength(2);
  });

  it('goes from restrictive defaults to the real policy once the file is fixed', () => {
    const { service, file } = setup('not json');
    expect(service.state.features.terminal).toBe(false);
    writeFileSync(file, '{ "version": 1, "features": { "terminal": true } }');
    service.reload();
    expect(service.state.features.terminal).toBe(true);
    expect(service.state.warnings).toEqual([]);
  });

  it('hands out a state that cannot be modified by accident', () => {
    const { service } = setup(GOOD);
    const state = service.state;
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.features)).toBe(true);
    expect(() => {
      state.features.terminal = true;
    }).toThrow(TypeError);
    expect(() => state.lockedKeys.push('editor.tabSize')).toThrow(TypeError);
  });

  it('reports each distinct warning once in the log', () => {
    const { service, file, logger } = setup('{ "version": 1, "settings": { "nope": 1 } }');
    const count = () => logger.warnings.filter((w) => w.includes('nope')).length;
    expect(count()).toBe(1);
    service.reload();
    service.reload();
    expect(count()).toBe(1);
    writeFileSync(file, '{ "version": 1, "settings": { "nope": 2, "nope2": 1 } }');
    service.reload();
    expect(logger.warnings.filter((w) => w.includes('nope2')).length).toBe(1);
  });

  it('follows changes made by other programs', async () => {
    const { service, file, states } = setup(GOOD, true);
    try {
      writeFileSync(file, '{ "version": 1, "features": { "tasks": false } }');
      await waitFor(() => states.length > 0, 'policy change event');
      expect(service.state.features.tasks).toBe(false);
      expect(service.state.features.terminal).toBe(true);
      expect(service.state.lockedKeys).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it('picks up a policy file created after startup in a folder that did not exist', async () => {
    const dir = tempDir('inc-policy-');
    const file = path.join(dir, 'managed', 'policy.json');
    const service = new PolicyService({
      file,
      logger: recordingLogger(),
      watch: true,
      debounceMs: 20,
    });
    const states: PolicyState[] = [];
    service.onDidChange((s) => states.push(s));
    try {
      mkdirSync(path.dirname(file));
      writeFileSync(file, GOOD);
      await waitFor(() => states.length > 0, 'policy file creation', 8000);
      expect(service.state.lockedKeys).toEqual(['editor.fontSize']);
    } finally {
      service.dispose();
    }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'treats an unreadable file as unusable, not as absent',
    () => {
      const { service, file } = setup(GOOD);
      chmodSync(file, 0o000);
      try {
        service.reload();
        expect(service.state.warnings.join(' ')).toContain('last valid policy');
        expect(service.state.features.terminal).toBe(false);
      } finally {
        chmodSync(file, 0o600);
      }
    },
  );
});
