/**
 * Shell profile detection.
 *
 * Everything that touches the machine (environment, file existence, /etc/shells, real paths) is
 * injected through `DetectionEnv`, so the rules can be tested for every platform on any host.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { TerminalProfile } from '@shared/api/terminal';
import type { EnvMap } from './environment';

export type ShellKind =
  'pwsh' | 'powershell' | 'cmd' | 'git-bash' | 'bash' | 'zsh' | 'fish' | 'other';

/** A profile plus what the main process needs to know about how to run it. */
export interface ShellProfile extends TerminalProfile {
  kind: ShellKind;
}

export interface DetectionEnv {
  platform: NodeJS.Platform;
  env: EnvMap;
  /** True when a file (not a directory) exists at the path. */
  isFile(file: string): boolean;
  /** Contents of a small text file, or null when it cannot be read. */
  readText(file: string): string | null;
  /** Canonical path, used to drop duplicates such as /bin/bash and /usr/bin/bash. */
  realPath(file: string): string;
}

const UNIX_SHELLS: Record<string, ShellKind> = { bash: 'bash', zsh: 'zsh', fish: 'fish' };

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Case-insensitive lookup on Windows, exact elsewhere. */
export function envValue(env: EnvMap, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const wanted = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === wanted && typeof value === 'string') return value;
  }
  return undefined;
}

/** First directory on PATH that contains `name`. */
export function findOnPath(name: string, detection: DetectionEnv): string | null {
  const api = pathApi(detection.platform);
  const raw = envValue(detection.env, 'PATH', detection.platform) ?? '';
  for (const dir of raw.split(api.delimiter)) {
    const trimmed = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmed || !api.isAbsolute(trimmed)) continue;
    const candidate = api.join(trimmed, name);
    if (detection.isFile(candidate)) return candidate;
  }
  return null;
}

function kindFromPath(file: string, platform: NodeJS.Platform): ShellKind {
  const api = pathApi(platform);
  const base = api.basename(file, api.extname(file)).toLowerCase();
  if (base === 'pwsh') return 'pwsh';
  if (base === 'powershell') return 'powershell';
  if (base === 'cmd') return 'cmd';
  return UNIX_SHELLS[base] ?? 'other';
}

/** Arguments that start the shell as an interactive session. */
function baseArgs(kind: ShellKind, platform: NodeJS.Platform): string[] {
  switch (kind) {
    case 'pwsh':
    case 'powershell':
      return ['-NoLogo'];
    case 'git-bash':
      return ['--login', '-i'];
    case 'bash':
    case 'zsh':
    case 'fish':
      // Applications started from the Dock or Finder do not have the user's login environment.
      return platform === 'darwin' ? ['-l'] : [];
    default:
      return [];
  }
}

function windowsProfiles(detection: DetectionEnv): ShellProfile[] {
  const { env, platform } = detection;
  const api = path.win32;
  const get = (name: string) => envValue(env, name, platform);
  const systemRoot = get('SystemRoot') ?? get('windir') ?? 'C:\\Windows';
  const programFiles = get('ProgramFiles') ?? 'C:\\Program Files';
  const programFilesX86 = get('ProgramFiles(x86)');
  const localAppData = get('LocalAppData');
  const result: ShellProfile[] = [];

  const add = (id: string, label: string, kind: ShellKind, candidates: (string | null)[]) => {
    const found = candidates.find((c): c is string => c !== null && detection.isFile(c));
    if (!found) return;
    result.push({ id, label, path: found, args: baseArgs(kind, platform), isDefault: false, kind });
  };

  add('pwsh', 'PowerShell', 'pwsh', [
    findOnPath('pwsh.exe', detection),
    api.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    api.join(programFiles, 'PowerShell', '7-preview', 'pwsh.exe'),
  ]);
  add('powershell', 'Windows PowerShell', 'powershell', [
    api.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]);
  add('cmd', 'Command Prompt', 'cmd', [
    get('ComSpec') ?? null,
    api.join(systemRoot, 'System32', 'cmd.exe'),
  ]);

  // The bash.exe on PATH in System32 is the WSL launcher, so Git for Windows is located from
  // its own install folders and from git.exe (<install>\cmd\git.exe -> <install>\bin\bash.exe).
  const git = findOnPath('git.exe', detection);
  add('git-bash', 'Git Bash', 'git-bash', [
    git ? api.join(api.dirname(api.dirname(git)), 'bin', 'bash.exe') : null,
    api.join(programFiles, 'Git', 'bin', 'bash.exe'),
    programFilesX86 ? api.join(programFilesX86, 'Git', 'bin', 'bash.exe') : null,
    localAppData ? api.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : null,
  ]);
  return result;
}

function unixProfiles(detection: DetectionEnv): ShellProfile[] {
  const { env, platform } = detection;
  const api = path.posix;
  const candidates: string[] = [];

  const userShell = env.SHELL;
  if (userShell && api.isAbsolute(userShell)) candidates.push(userShell);

  const shells = detection.readText('/etc/shells');
  if (shells) {
    for (const line of shells.split(/\r?\n/)) {
      const entry = line.trim();
      if (!entry || entry.startsWith('#') || !api.isAbsolute(entry)) continue;
      if (api.basename(entry) in UNIX_SHELLS) candidates.push(entry);
    }
  }

  const result: ShellProfile[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!detection.isFile(candidate)) continue;
    const real = detection.realPath(candidate);
    if (seen.has(real)) continue;
    seen.add(real);
    const kind = kindFromPath(candidate, platform);
    const name = api.basename(candidate);
    result.push({
      id: name,
      label: name,
      path: candidate,
      args: baseArgs(kind, platform),
      isDefault: false,
      kind,
    });
  }

  if (result.length === 0 && detection.isFile('/bin/sh')) {
    result.push({
      id: 'sh',
      label: 'sh',
      path: '/bin/sh',
      args: [],
      isDefault: false,
      kind: 'other',
    });
  }
  return result;
}

/** Two shells with the same executable name (for example two bash installs) keep distinct ids. */
function disambiguate(profiles: ShellProfile[]): ShellProfile[] {
  const counts = new Map<string, number>();
  for (const p of profiles) counts.set(p.id, (counts.get(p.id) ?? 0) + 1);
  return profiles.map((p) => {
    if ((counts.get(p.id) ?? 0) < 2) return p;
    const suffix = createHash('sha1').update(p.path).digest('hex').slice(0, 6);
    return { ...p, id: `${p.id}-${suffix}`, label: `${p.label} (${p.path})` };
  });
}

/** Detected profiles in preference order. The first one is marked as the default. */
export function detectProfiles(detection: DetectionEnv): ShellProfile[] {
  const found =
    detection.platform === 'win32' ? windowsProfiles(detection) : unixProfiles(detection);
  const profiles = disambiguate(found);
  const first = profiles[0];
  if (first) first.isDefault = true;
  return profiles;
}

export interface ShellSettings {
  /** `terminal.shell`; must only be supplied for a trusted workspace. */
  shell: string;
  /** `terminal.shellArgs`; must only be supplied for a trusted workspace. */
  shellArgs: string[];
}

export interface ResolvedProfiles {
  profiles: ShellProfile[];
  /** Set when `terminal.shell` is configured but cannot be used. */
  customProblem: string | null;
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Apply `terminal.shell` and `terminal.shellArgs` to the detected profiles. A configured shell
 * that matches a detected one makes that profile the default; any other valid path becomes the
 * `custom` profile. The extra arguments belong to whichever profile ends up as the default.
 */
export function applyShellSettings(
  detected: ShellProfile[],
  settings: ShellSettings | null,
  detection: DetectionEnv,
): ResolvedProfiles {
  const profiles = detected.map((p) => ({ ...p, args: [...p.args] }));
  if (!settings) return { profiles, customProblem: null };

  const api = pathApi(detection.platform);
  const extra = settings.shellArgs.filter((a) => typeof a === 'string');
  const configured = settings.shell.trim();
  let customProblem: string | null = null;

  if (configured) {
    if (!api.isAbsolute(configured)) {
      customProblem = `The shell set in terminal.shell must be an absolute path: ${configured}`;
    } else if (!detection.isFile(configured)) {
      customProblem = `The shell set in terminal.shell was not found: ${configured}`;
    } else {
      const match = profiles.find((p) => samePath(p.path, configured, detection.platform));
      for (const p of profiles) p.isDefault = false;
      if (match) {
        match.isDefault = true;
      } else {
        const name = api.basename(configured);
        profiles.unshift({
          id: 'custom',
          label: `Custom (${name})`,
          path: configured,
          args: [],
          isDefault: true,
          kind: kindFromPath(configured, detection.platform),
        });
      }
    }
  }

  if (customProblem === null) {
    const target = profiles.find((p) => p.isDefault);
    if (target && extra.length > 0) target.args = [...target.args, ...extra];
  }
  return { profiles, customProblem };
}
