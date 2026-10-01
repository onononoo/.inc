import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { GitAvailability } from '@shared/api/git';
import type { Platform } from '@shared/paths';

/** Oldest Git this slice supports (`git restore`, `rev-parse --absolute-git-dir`, porcelain v2). */
export const MIN_GIT_VERSION = { major: 2, minor: 23 } as const;

export interface GitVersion {
  /** Text after "git version", for example "2.43.0.windows.1". */
  text: string;
  major: number;
  minor: number;
  patch: number;
}

export interface LocateDeps {
  platform: Platform;
  env: NodeJS.ProcessEnv;
  isFile(candidate: string): boolean;
  isDirectory(candidate: string): boolean;
  /** Run an executable. Resolves with the exit code and stdout; rejects when it cannot start. */
  exec(file: string, args: string[]): Promise<{ code: number; stdout: string }>;
}

export function defaultLocateDeps(): LocateDeps {
  return {
    platform: process.platform as Platform,
    env: process.env,
    isFile: (candidate) => {
      try {
        return fs.statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
    isDirectory: (candidate) => {
      try {
        return fs.statSync(candidate).isDirectory();
      } catch {
        return false;
      }
    },
    exec: (file, args) =>
      new Promise((resolve, reject) => {
        execFile(
          file,
          args,
          { timeout: 15_000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
          (error, stdout) => {
            if (!error) return resolve({ code: 0, stdout });
            const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
            if (typeof code === 'number') return resolve({ code, stdout: stdout ?? '' });
            reject(error);
          },
        );
      }),
  };
}

export function parseGitVersion(output: string): GitVersion | null {
  const match = /git version\s+((\d+)\.(\d+)(?:\.(\d+))?\S*)/i.exec(output);
  if (!match) return null;
  return {
    text: match[1] ?? '',
    major: Number(match[2]),
    minor: Number(match[3]),
    patch: Number(match[4] ?? 0),
  };
}

export function isSupportedVersion(version: GitVersion): boolean {
  if (version.major !== MIN_GIT_VERSION.major) return version.major > MIN_GIT_VERSION.major;
  return version.minor >= MIN_GIT_VERSION.minor;
}

function executableNames(platform: Platform): string[] {
  return platform === 'win32' ? ['git.exe'] : ['git'];
}

/** Executables named git on PATH, in PATH order. Relative PATH entries are ignored. */
export function pathCandidates(deps: LocateDeps): string[] {
  const rawPath = deps.env.PATH ?? deps.env.Path ?? deps.env.path ?? '';
  const delimiter = deps.platform === 'win32' ? ';' : ':';
  const pathApi = deps.platform === 'win32' ? path.win32 : path.posix;
  const found: string[] = [];
  for (const entry of rawPath.split(delimiter)) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !pathApi.isAbsolute(dir)) continue;
    for (const name of executableNames(deps.platform)) {
      const candidate = pathApi.join(dir, name);
      if (deps.isFile(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** Install locations tried when Git is not on PATH (a desktop app often starts with a short PATH). */
export function commonLocations(deps: LocateDeps): string[] {
  if (deps.platform === 'win32') {
    const roots = [
      deps.env.ProgramFiles,
      deps.env.ProgramW6432,
      deps.env['ProgramFiles(x86)'],
      deps.env.LocalAppData ? path.win32.join(deps.env.LocalAppData, 'Programs') : undefined,
    ];
    const out: string[] = [];
    for (const root of roots) {
      if (!root) continue;
      out.push(path.win32.join(root, 'Git', 'cmd', 'git.exe'));
      out.push(path.win32.join(root, 'Git', 'bin', 'git.exe'));
    }
    return out;
  }
  if (deps.platform === 'darwin') {
    return ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'];
  }
  return ['/usr/bin/git', '/usr/local/bin/git', '/bin/git'];
}

type Verified =
  | { ok: true; path: string; version: GitVersion }
  | { ok: false; reason: 'missing' | 'broken' | 'old'; version?: GitVersion };

async function verify(candidate: string, deps: LocateDeps): Promise<Verified> {
  if (!deps.isFile(candidate)) return { ok: false, reason: 'missing' };
  try {
    // /usr/bin/git on macOS is a stub that opens an installer dialog when the developer tools are
    // missing, so only run it when they are installed.
    if (deps.platform === 'darwin' && candidate === '/usr/bin/git') {
      const tools = await deps.exec('/usr/bin/xcode-select', ['-p']);
      if (tools.code !== 0) return { ok: false, reason: 'missing' };
    }
    const result = await deps.exec(candidate, ['--version']);
    const version = result.code === 0 ? parseGitVersion(result.stdout) : null;
    if (!version) return { ok: false, reason: 'broken' };
    if (!isSupportedVersion(version)) return { ok: false, reason: 'old', version };
    return { ok: true, path: candidate, version };
  } catch {
    return { ok: false, reason: 'broken' };
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const match = /^(["'])(.*)\1$/.exec(trimmed);
  return match ? (match[2] ?? '').trim() : trimmed;
}

/** Candidates for a `git.path` value: a file, an install folder, or a bare command name. */
function configuredCandidates(configured: string, deps: LocateDeps): string[] | null {
  const pathApi = deps.platform === 'win32' ? path.win32 : path.posix;
  if (!/[\\/]/.test(configured)) {
    const wanted = configured.toLowerCase();
    return pathCandidates(deps).filter((candidate) => {
      const base = pathApi.basename(candidate).toLowerCase();
      return base === wanted || base === `${wanted}.exe`;
    });
  }
  if (!pathApi.isAbsolute(configured)) return null;
  if (deps.isDirectory(configured)) {
    return [
      pathApi.join(configured, 'cmd', executableNames(deps.platform)[0] ?? 'git'),
      pathApi.join(configured, 'bin', executableNames(deps.platform)[0] ?? 'git'),
      pathApi.join(configured, executableNames(deps.platform)[0] ?? 'git'),
    ];
  }
  return [configured];
}

/**
 * Find a usable Git. A configured `git.path` is authoritative: when it does not work the result
 * says so instead of silently using a different Git than the administrator chose.
 */
export async function locateGit(
  configured: string,
  deps: LocateDeps = defaultLocateDeps(),
): Promise<GitAvailability> {
  const wanted = unquote(configured);
  if (wanted) {
    const candidates = configuredCandidates(wanted, deps);
    if (candidates === null) {
      return {
        available: false,
        error: `The Git path "${wanted}" must be an absolute path or the name of a command on PATH.`,
      };
    }
    let old: GitVersion | undefined;
    for (const candidate of candidates) {
      const result = await verify(candidate, deps);
      if (result.ok) {
        return { available: true, version: result.version.text, path: result.path };
      }
      if (result.reason === 'old') old = result.version;
    }
    if (old) return { available: false, error: oldVersionMessage(old) };
    return {
      available: false,
      error: `The Git path "${wanted}" does not point to a working Git executable. Check the git.path setting.`,
    };
  }

  const seen = new Set<string>();
  let old: GitVersion | undefined;
  for (const candidate of [...pathCandidates(deps), ...commonLocations(deps)]) {
    const key = deps.platform === 'linux' ? candidate : candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const result = await verify(candidate, deps);
    if (result.ok) return { available: true, version: result.version.text, path: result.path };
    if (result.reason === 'old' && !old) old = result.version;
  }
  if (old) return { available: false, error: oldVersionMessage(old) };
  return { available: false, error: 'Git was not found. Install Git or set its path in settings.' };
}

function oldVersionMessage(version: GitVersion): string {
  return `Git ${version.text} is too old. Git ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor} or newer is required.`;
}
