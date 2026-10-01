import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { IncError } from '@shared/errors';
import type { Logger } from '../kernel';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const STDERR_LIMIT_BYTES = 256 * 1024;

/** Environment variables that would point Git at a different repository than the workspace. */
const STRIPPED_VARIABLES = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PAGER',
  'GIT_OPTIONAL_LOCKS',
  'GIT_TERMINAL_PROMPT',
  'GIT_MERGE_AUTOEDIT',
  'GIT_LITERAL_PATHSPECS',
  'LC_ALL',
  'LANGUAGE',
  'EDITOR',
  'VISUAL',
  'PAGER',
]);

/** "Do nothing" command understood by the shell Git uses to start editors. */
const NO_EDITOR = ':';

export interface EnvOptions {
  /** Read operations never take optional locks, so polling cannot block the user's own Git commands. */
  readOnly: boolean;
  /** Extra variables, applied last. */
  extra?: Record<string, string>;
}

/**
 * The environment for every Git process: the user's environment (so credential helpers, SSH agents
 * and proxies keep working) minus anything that retargets Git or could open an editor or pager,
 * with prompts disabled and output in the C locale so it can be parsed.
 */
export function buildGitEnv(base: NodeJS.ProcessEnv, options: EnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== 'string' || STRIPPED_VARIABLES.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  env.LC_ALL = 'C';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_EDITOR = NO_EDITOR;
  env.GIT_SEQUENCE_EDITOR = NO_EDITOR;
  env.EDITOR = NO_EDITOR;
  env.VISUAL = NO_EDITOR;
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_MERGE_AUTOEDIT = 'no';
  if (options.readOnly) env.GIT_OPTIONAL_LOCKS = '0';
  return { ...env, ...options.extra };
}

export interface ConfigOptions {
  /** True for an untrusted workspace: repository configuration must not be able to run code. */
  hardened: boolean;
  /** An empty directory used as `core.hooksPath` when hardened. */
  hooksDir: string;
  /** More `key=value` overrides, for example emptied filter commands. */
  overrides?: readonly string[];
}

/** `-c key=value` arguments placed before the Git sub-command. */
export function buildConfigArgs(options: ConfigOptions): string[] {
  const settings = ['core.quotepath=false', 'color.ui=false', 'core.longpaths=true'];
  if (options.hardened) {
    settings.push(
      'core.fsmonitor=false',
      `core.hooksPath=${options.hooksDir.replace(/\\/g, '/')}`,
      'protocol.ext.allow=never',
    );
  }
  settings.push(...(options.overrides ?? []));
  return settings.flatMap((setting) => ['-c', setting]);
}

export interface RunOptions {
  /** Absolute path of the Git executable. */
  gitPath: string;
  cwd: string;
  /** Arguments after the global options. Never joined into a shell string. */
  args: readonly string[];
  /** 'write' operations may take locks; 'read' (default) never do. */
  mode?: 'read' | 'write';
  /** Untrusted workspace: add the flags that stop repository configuration from running code. */
  hardened?: boolean;
  /** Extra `-c key=value` overrides (see `ConfigOptions.overrides`). */
  configOverrides?: readonly string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Fail with E_TOO_LARGE when output exceeds this many bytes. */
  maxOutputBytes?: number;
  /** Text written to stdin. */
  input?: string | Uint8Array;
  env?: Record<string, string>;
  /** Receive stdout as it arrives instead of buffering it (the result's stdout is then empty). */
  onStdout?: (chunk: Buffer) => void;
  /** Stop after this many bytes of stdout and return what was read, without an error. */
  stopAfterBytes?: number;
}

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  /** True when `stopAfterBytes` ended the command early. */
  truncated: boolean;
  durationMs: number;
}

export interface RunnerOptions {
  /** Absolute path of an empty directory, created on first use, for `core.hooksPath`. */
  hooksDir: () => string;
  logger: Logger;
}

/** Kill a process and everything it started (hooks, credential helpers, ssh). */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* the group is already gone */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already exited */
  }
}

function cancelled(): IncError {
  return new IncError('E_CANCELLED', 'The Git operation was cancelled.');
}

/**
 * Runs the Git CLI with an argument array (never a shell), bounded in time and output, and
 * cancellable. One runner per workspace session; `dispose` kills whatever is still running.
 */
export class GitRunner {
  private readonly active = new Set<ChildProcess>();
  private disposed = false;

  constructor(private readonly options: RunnerOptions) {}

  get activeCount(): number {
    return this.active.size;
  }

  run(opts: RunOptions): Promise<RunResult> {
    if (this.disposed) return Promise.reject(cancelled());
    if (opts.signal?.aborted) return Promise.reject(cancelled());

    let configArgs: string[];
    try {
      configArgs = buildConfigArgs({
        hardened: opts.hardened === true,
        hooksDir: opts.hardened ? this.options.hooksDir() : '',
        overrides: opts.configOverrides,
      });
    } catch (e) {
      return Promise.reject(e);
    }
    const args = [...configArgs, ...opts.args];
    const env = buildGitEnv(process.env, { readOnly: opts.mode !== 'write', extra: opts.env });
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutput = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const hasInput = opts.input !== undefined;
    const started = Date.now();

    return new Promise<RunResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(opts.gitPath, args, {
          cwd: opts.cwd,
          env,
          windowsHide: true,
          stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (e) {
        reject(this.spawnFailure(e, opts));
        return;
      }
      this.active.add(child);

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let outBytes = 0;
      let bufferedBytes = 0;
      let errBytes = 0;
      let settled = false;

      const finish = (outcome: { value: RunResult } | { error: unknown }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        this.active.delete(child);
        if ('error' in outcome) reject(outcome.error);
        else resolve(outcome.value);
      };
      const result = (code: number, truncated: boolean): RunResult => ({
        code,
        stdout: Buffer.concat(chunks, bufferedBytes),
        stderr: Buffer.concat(errChunks, errBytes).toString('utf8'),
        truncated,
        durationMs: Date.now() - started,
      });
      const abandon = (error: unknown) => {
        killProcessTree(child);
        finish({ error });
      };

      const onAbort = () => abandon(cancelled());
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        this.options.logger.warn(`git ${opts.args[0] ?? ''} timed out after ${timeoutMs} ms`);
        abandon(
          new IncError(
            'E_GIT',
            `Git did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped. ` +
              'Try again, or use a terminal for this operation.',
            { timedOut: true },
          ),
        );
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        outBytes += chunk.length;
        if (opts.stopAfterBytes !== undefined && outBytes >= opts.stopAfterBytes) {
          chunks.push(chunk);
          bufferedBytes += chunk.length;
          killProcessTree(child);
          finish({ value: result(0, true) });
          return;
        }
        if (outBytes > maxOutput) {
          abandon(
            new IncError(
              'E_TOO_LARGE',
              'Git produced more output than can be handled. Narrow the request and try again.',
            ),
          );
          return;
        }
        if (opts.onStdout) {
          try {
            opts.onStdout(chunk);
          } catch (e) {
            abandon(e);
          }
          return;
        }
        chunks.push(chunk);
        bufferedBytes += chunk.length;
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        if (errBytes >= STDERR_LIMIT_BYTES) return;
        errChunks.push(chunk);
        errBytes += chunk.length;
      });
      child.on('error', (e) => {
        killProcessTree(child);
        finish({ error: this.spawnFailure(e, opts) });
      });
      child.on('close', (code) => {
        finish({ value: result(code ?? -1, false) });
      });

      if (hasInput && child.stdin) {
        child.stdin.on('error', () => undefined); // the process may exit before reading everything
        child.stdin.end(opts.input);
      }
    });
  }

  private spawnFailure(error: unknown, opts: RunOptions): IncError {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (!fs.existsSync(opts.cwd)) {
        return new IncError('E_NOT_FOUND', 'The workspace folder no longer exists.', {
          path: opts.cwd,
        });
      }
      return new IncError(
        'E_GIT_MISSING',
        'Git was not found. Install Git or set its path in settings.',
        { path: opts.gitPath },
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return new IncError(
        'E_GIT_MISSING',
        `Git at ${opts.gitPath} cannot be run: permission denied.`,
        {
          path: opts.gitPath,
        },
      );
    }
    return new IncError('E_GIT', `Git could not be started: ${(error as Error).message}`);
  }

  /** Kill every running process and refuse new ones. */
  dispose(): void {
    this.disposed = true;
    for (const child of [...this.active]) killProcessTree(child);
    this.active.clear();
  }
}
