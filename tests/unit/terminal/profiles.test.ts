import { describe, expect, it } from 'vitest';
import {
  applyShellSettings,
  detectProfiles,
  envValue,
  findOnPath,
} from '../../../src/main/terminal/profiles';
import { fakeMachine } from './helpers';

const WIN_ENV = {
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  ProgramFiles: 'C:\\Program Files',
  Path: 'C:\\Windows\\System32;C:\\Tools',
};
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

describe('Windows profile detection', () => {
  it('lists PowerShell 7 first, then Windows PowerShell, Command Prompt and Git Bash', () => {
    const machine = fakeMachine('win32', WIN_ENV, [PWSH, POWERSHELL, CMD, GIT_BASH]);
    const profiles = detectProfiles(machine);
    expect(profiles.map((p) => p.id)).toEqual(['pwsh', 'powershell', 'cmd', 'git-bash']);
    expect(profiles.map((p) => p.isDefault)).toEqual([true, false, false, false]);
    expect(profiles[0]!.label).toBe('PowerShell');
    expect(profiles[3]!.args).toEqual(['--login', '-i']);
  });

  it('falls back to Windows PowerShell when PowerShell 7 is not installed', () => {
    const profiles = detectProfiles(fakeMachine('win32', WIN_ENV, [POWERSHELL, CMD]));
    expect(profiles.map((p) => p.id)).toEqual(['powershell', 'cmd']);
    expect(profiles[0]!.isDefault).toBe(true);
  });

  it('finds pwsh on PATH and matches the variable name without regard to case', () => {
    const custom = 'D:\\Tools\\pwsh.exe';
    const machine = fakeMachine('win32', { ...WIN_ENV, Path: 'D:\\Tools;C:\\Windows' }, [custom]);
    expect(detectProfiles(machine)[0]).toMatchObject({ id: 'pwsh', path: custom });
    expect(envValue({ PATH: 'x' }, 'Path', 'win32')).toBe('x');
    expect(envValue({ PATH: 'x' }, 'Path', 'linux')).toBeUndefined();
  });

  it('locates Git Bash from git.exe and never uses the WSL bash.exe in System32', () => {
    const machine = fakeMachine(
      'win32',
      { ...WIN_ENV, Path: 'C:\\Windows\\System32;D:\\Dev\\Git\\cmd' },
      [
        'C:\\Windows\\System32\\bash.exe',
        'D:\\Dev\\Git\\cmd\\git.exe',
        'D:\\Dev\\Git\\bin\\bash.exe',
      ],
    );
    const profiles = detectProfiles(machine);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: 'git-bash', path: 'D:\\Dev\\Git\\bin\\bash.exe' });
  });

  it('returns nothing when no shell exists', () => {
    expect(detectProfiles(fakeMachine('win32', WIN_ENV, []))).toEqual([]);
  });

  it('ignores relative PATH entries', () => {
    const machine = fakeMachine('win32', { ...WIN_ENV, Path: '.;tools' }, ['tools\\pwsh.exe']);
    expect(findOnPath('pwsh.exe', machine)).toBeNull();
  });
});

describe('macOS and Linux profile detection', () => {
  const shells = '# list\n/bin/sh\n/bin/bash\n/usr/bin/zsh\n/usr/bin/fish\n/usr/bin/tmux\n\n';

  it('puts $SHELL first and adds bash, zsh and fish from /etc/shells that exist', () => {
    const machine = fakeMachine(
      'linux',
      { SHELL: '/usr/bin/zsh' },
      ['/bin/sh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/fish'],
      { '/etc/shells': shells },
    );
    const profiles = detectProfiles(machine);
    expect(profiles.map((p) => p.id)).toEqual(['zsh', 'bash', 'fish']);
    expect(profiles[0]!.isDefault).toBe(true);
    expect(profiles.every((p) => p.args.length === 0)).toBe(true);
  });

  it('skips entries that do not exist and keeps the order of /etc/shells', () => {
    const machine = fakeMachine('linux', {}, ['/bin/bash', '/usr/bin/fish'], {
      '/etc/shells': shells,
    });
    expect(detectProfiles(machine).map((p) => p.path)).toEqual(['/bin/bash', '/usr/bin/fish']);
  });

  it('drops duplicates that resolve to the same executable', () => {
    const machine = fakeMachine(
      'linux',
      { SHELL: '/bin/bash' },
      ['/bin/bash', '/usr/bin/bash'],
      { '/etc/shells': '/bin/bash\n/usr/bin/bash\n' },
      { '/bin/bash': '/usr/bin/bash' },
    );
    expect(detectProfiles(machine)).toHaveLength(1);
  });

  it('keeps distinct ids for different shells with the same name', () => {
    const machine = fakeMachine('linux', {}, ['/bin/bash', '/opt/homebrew/bin/bash'], {
      '/etc/shells': '/bin/bash\n/opt/homebrew/bin/bash\n',
    });
    const ids = detectProfiles(machine).map((p) => p.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.startsWith('bash-'))).toBe(true);
  });

  it('accepts an unusual $SHELL and ignores a relative one', () => {
    const nu = fakeMachine('linux', { SHELL: '/usr/bin/nu' }, ['/usr/bin/nu']);
    expect(detectProfiles(nu)[0]).toMatchObject({ id: 'nu', kind: 'other' });
    const relative = fakeMachine('linux', { SHELL: 'zsh' }, ['/bin/sh']);
    expect(detectProfiles(relative).map((p) => p.id)).toEqual(['sh']);
  });

  it('starts shells as login shells on macOS only', () => {
    const files = ['/bin/zsh'];
    const mac = detectProfiles(fakeMachine('darwin', { SHELL: '/bin/zsh' }, files));
    const linux = detectProfiles(fakeMachine('linux', { SHELL: '/bin/zsh' }, files));
    expect(mac[0]!.args).toEqual(['-l']);
    expect(linux[0]!.args).toEqual([]);
  });

  it('falls back to /bin/sh when nothing else is found', () => {
    expect(detectProfiles(fakeMachine('linux', {}, ['/bin/sh'])).map((p) => p.id)).toEqual(['sh']);
  });
});

describe('terminal.shell and terminal.shellArgs', () => {
  const machine = fakeMachine(
    'linux',
    { SHELL: '/bin/bash' },
    ['/bin/bash', '/usr/bin/zsh', '/opt/tools/nu'],
    { '/etc/shells': '/bin/bash\n/usr/bin/zsh\n' },
  );
  const detected = detectProfiles(machine);

  it('changes nothing without settings', () => {
    const result = applyShellSettings(detected, null, machine);
    expect(result.profiles.map((p) => p.id)).toEqual(['bash', 'zsh']);
    expect(result.customProblem).toBeNull();
  });

  it('makes a detected shell the default when the path matches', () => {
    const result = applyShellSettings(
      detected,
      { shell: '/usr/bin/zsh', shellArgs: ['-f'] },
      machine,
    );
    expect(result.profiles.find((p) => p.isDefault)).toMatchObject({ id: 'zsh', args: ['-f'] });
    expect(result.profiles.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it('adds an unknown but valid shell as the custom default profile', () => {
    const result = applyShellSettings(
      detected,
      { shell: '/opt/tools/nu', shellArgs: ['--login'] },
      machine,
    );
    expect(result.profiles[0]).toMatchObject({
      id: 'custom',
      path: '/opt/tools/nu',
      args: ['--login'],
      isDefault: true,
    });
    expect(result.profiles.filter((p) => p.isDefault)).toHaveLength(1);
  });

  it('applies the arguments to the default shell when no shell is configured', () => {
    const result = applyShellSettings(detected, { shell: '', shellArgs: ['--norc'] }, machine);
    expect(result.profiles[0]).toMatchObject({ id: 'bash', args: ['--norc'] });
  });

  it('reports a shell that is missing or not absolute and leaves the profiles alone', () => {
    const missing = applyShellSettings(detected, { shell: '/nope/sh', shellArgs: ['-x'] }, machine);
    expect(missing.customProblem).toMatch(/was not found/);
    expect(missing.profiles.map((p) => p.id)).toEqual(['bash', 'zsh']);
    expect(missing.profiles[0]!.args).toEqual([]);
    const relative = applyShellSettings(detected, { shell: 'zsh', shellArgs: [] }, machine);
    expect(relative.customProblem).toMatch(/absolute path/);
  });

  it('compares Windows paths without regard to case', () => {
    const win = fakeMachine('win32', WIN_ENV, [PWSH, CMD]);
    const result = applyShellSettings(
      detectProfiles(win),
      { shell: CMD.toLowerCase(), shellArgs: [] },
      fakeMachine('win32', WIN_ENV, [PWSH, CMD, CMD.toLowerCase()]),
    );
    expect(result.profiles.find((p) => p.isDefault)?.id).toBe('cmd');
  });
});
