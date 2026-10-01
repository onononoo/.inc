import { describe, expect, it } from 'vitest';
import {
  buildTerminalEnv,
  isHiddenVariable,
  isValidVariableName,
} from '../../../src/main/terminal/environment';

const base = {
  PATH: '/usr/bin',
  HOME: '/home/dev',
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_ENABLE_LOGGING: '0',
  INC_USER_DATA_DIR: '/tmp/x',
  INC_POLICY_FILE: '/etc/inc/policy.json',
  NODE_OPTIONS: '--require leak.js',
  CHROME_DESKTOP: 'inc.desktop',
  KEEP_ME: 'yes',
};

describe('buildTerminalEnv', () => {
  it('drops application internals and keeps the user environment', () => {
    const env = buildTerminalEnv({ base, appVersion: '1.2.3', platform: 'linux' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/dev');
    expect(env.KEEP_ME).toBe('yes');
    for (const name of Object.keys(env)) {
      expect(name).not.toMatch(/^(ELECTRON_|INC_)/);
    }
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.CHROME_DESKTOP).toBeUndefined();
  });

  it('sets the terminal identification variables', () => {
    const env = buildTerminalEnv({
      base: { TERM: 'dumb' },
      appVersion: '1.2.3',
      platform: 'linux',
    });
    expect(env).toMatchObject({
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'inc',
      TERM_PROGRAM_VERSION: '1.2.3',
    });
  });

  it('matches hidden names regardless of case', () => {
    expect(isHiddenVariable('electron_foo')).toBe(true);
    expect(isHiddenVariable('Inc_Anything')).toBe(true);
    expect(isHiddenVariable('node_options')).toBe(true);
    expect(isHiddenVariable('INCLUDE')).toBe(false);
    expect(isHiddenVariable('PATH')).toBe(false);
  });

  it('applies terminal.env on top of the base and reports invalid entries', () => {
    const rejected: string[] = [];
    const env = buildTerminalEnv({
      base,
      extra: {
        KEEP_ME: 'overridden',
        NEW_VAR: 'a',
        'BAD=NAME': 'x',
        EMPTY: '',
        NUM: 5,
        NUL: 'a\u0000b',
      },
      appVersion: '1',
      platform: 'linux',
      onRejected: (name) => rejected.push(name),
    });
    expect(env.KEEP_ME).toBe('overridden');
    expect(env.NEW_VAR).toBe('a');
    expect(env.EMPTY).toBe('');
    expect(rejected.sort()).toEqual(['BAD=NAME', 'NUL', 'NUM']);
    expect(env['BAD=NAME']).toBeUndefined();
  });

  it('lets terminal.env set a variable the application hides from the inherited environment', () => {
    // The user's own configuration is explicit, so only the inherited environment is filtered.
    const env = buildTerminalEnv({
      base,
      extra: { NODE_OPTIONS: '--max-old-space-size=4096' },
      appVersion: '1',
      platform: 'linux',
    });
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096');
  });

  it('merges names case-insensitively on Windows only', () => {
    const win = buildTerminalEnv({
      base: { Path: 'C:\\a', SystemRoot: 'C:\\Windows' },
      extra: { PATH: 'C:\\b' },
      appVersion: '1',
      platform: 'win32',
    });
    expect(Object.keys(win).filter((k) => k.toUpperCase() === 'PATH')).toEqual(['PATH']);
    expect(win.PATH).toBe('C:\\b');
    const linux = buildTerminalEnv({
      base: { Path: 'a' },
      extra: { PATH: 'b' },
      appVersion: '1',
      platform: 'linux',
    });
    expect(linux.Path).toBe('a');
    expect(linux.PATH).toBe('b');
  });

  it('hides application variables in any case on Windows', () => {
    const env = buildTerminalEnv({
      base: { Electron_Run_As_Node: '1', Path: 'x' },
      appVersion: '1',
      platform: 'win32',
    });
    expect(env.Electron_Run_As_Node).toBeUndefined();
  });

  it('gives macOS a UTF-8 locale when launched without one', () => {
    const mac = (b: Record<string, string>) =>
      buildTerminalEnv({ base: b, appVersion: '1', platform: 'darwin' });
    expect(mac({}).LANG).toBe('en_US.UTF-8');
    expect(mac({ LANG: 'de_DE.UTF-8' }).LANG).toBe('de_DE.UTF-8');
    expect(buildTerminalEnv({ base: {}, appVersion: '1', platform: 'linux' }).LANG).toBeUndefined();
  });

  it('skips non-string and malformed base entries', () => {
    const env = buildTerminalEnv({
      base: { OK: 'x', UNSET: undefined, '': 'empty', 'A=B': 'c' },
      appVersion: '1',
      platform: 'linux',
    });
    expect(env.OK).toBe('x');
    expect('UNSET' in env).toBe(false);
    expect(isValidVariableName('')).toBe(false);
    expect(isValidVariableName('A=B')).toBe(false);
  });
});
