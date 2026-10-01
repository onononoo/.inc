/**
 * Starting shells: a real pseudo-terminal through node-pty, or a pipe fallback.
 *
 * The pipe fallback exists so a terminal still works when node-pty cannot be loaded or cannot
 * start (a blocked native module, an unsupported platform). Its limits are inherent to pipes and
 * are reported to the user through `fallbackReason`:
 *  - the shell does not see a terminal, so full-screen programs, colours that depend on a TTY,
 *    prompts and job control are unavailable;
 *  - typed characters are echoed and edited locally (see LineDiscipline), with no history and no
 *    cursor movement;
 *  - Ctrl+C cannot interrupt a running command on every platform, so it only clears the line;
 *  - on Windows the console code page decides how non-ASCII output is encoded, so accented
 *    characters may display incorrectly in Command Prompt and Windows PowerShell.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type * as NodePty from 'node-pty';
import { IncError } from '@shared/errors';
import { LineDiscipline, NewlineTranslator } from './line-discipline';
import { KILL_GRACE_MS, terminateTree } from './process-tree';
import type { ShellKind } from './profiles';

export interface ShellExit {
  exitCode: number | null;
  signal?: number;
}

/** What the terminal manager needs from a running shell, whichever way it was started. */
export interface ShellProcess {
  readonly pid: number;
  readonly isPty: boolean;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: ShellExit) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  /** Stop the shell and everything it started. `sync` waits (used while quitting). */
  kill(sync?: boolean): void;
}

export interface SpawnOptions {
  file: string;
  args: string[];
  kind: ShellKind;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  platform?: NodeJS.Platform;
}

export type PtyModule = Pick<typeof NodePty, 'spawn'>;
/** Returns the node-pty module, or rejects when it cannot be loaded. */
export type PtyLoader = () => Promise<PtyModule>;

export const defaultPtyLoader: PtyLoader = async () => {
  const mod = (await import('node-pty')) as PtyModule & { default?: PtyModule };
  return typeof mod.spawn === 'function' ? mod : (mod.default as PtyModule);
};

// --- PTY ----------------------------------------------------------------------------------------

class PtyShell implements ShellProcess {
  readonly isPty = true;
  private exited = false;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly pty: NodePty.IPty,
    private readonly platform: NodeJS.Platform,
  ) {
    pty.onExit(() => {
      this.exited = true;
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = null;
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  onData(listener: (data: string) => void): void {
    this.pty.onData(listener);
  }

  onExit(listener: (exit: ShellExit) => void): void {
    this.pty.onExit((e) => listener({ exitCode: e.exitCode, signal: e.signal || undefined }));
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      /* the shell ended between the check and the call */
    }
  }

  pause(): void {
    if (!this.exited) this.pty.pause();
  }

  resume(): void {
    if (!this.exited) this.pty.resume();
  }

  kill(sync = false): void {
    if (this.exited) return;
    const pid = this.pty.pid;
    if (this.platform === 'win32') {
      terminateTree(pid, { platform: this.platform, sync });
      try {
        this.pty.kill();
      } catch {
        /* already closed by taskkill */
      }
      return;
    }
    terminateTree(pid, { platform: this.platform, signal: 'SIGHUP' });
    if (sync) {
      terminateTree(pid, { platform: this.platform, signal: 'SIGKILL' });
      return;
    }
    // A shell that ignores hang-up (a foreground program that traps it) is killed after a grace period.
    this.killTimer = setTimeout(() => {
      if (!this.exited) terminateTree(pid, { platform: this.platform, signal: 'SIGKILL' });
    }, KILL_GRACE_MS);
    this.killTimer.unref();
  }
}

// --- Pipes --------------------------------------------------------------------------------------

/** How long to wait for output still in the pipes after the shell itself has exited. */
const DRAIN_MS = 250;

/**
 * Arguments for running a shell without a terminal. Interactive flags are dropped (they make
 * shells print prompts and warnings about missing job control), and Command Prompt is told not to
 * echo commands, because the line discipline already shows what was typed.
 */
export function pipeArguments(kind: ShellKind, args: string[]): string[] {
  switch (kind) {
    case 'cmd':
      return ['/Q', '/D', ...args];
    case 'git-bash':
    case 'bash':
    case 'zsh':
    case 'fish':
      return args.filter((a) => a !== '-i' && a !== '--interactive');
    default:
      return args;
  }
}

class PipeShell implements ShellProcess {
  readonly isPty = false;
  private readonly discipline = new LineDiscipline();
  private readonly newlines = new NewlineTranslator();
  private readonly dataListeners: ((data: string) => void)[] = [];
  private readonly exitListeners: ((exit: ShellExit) => void)[] = [];
  private exited = false;
  private killTimer: NodeJS.Timeout | null = null;
  private readonly eol: string;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly platform: NodeJS.Platform,
    notice: string,
  ) {
    this.eol = platform === 'win32' ? '\r\n' : '\n';
    const forward = (chunk: string) => this.emit(this.newlines.translate(chunk));
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', forward);
      stream.on('error', () => undefined);
    }
    child.stdin.on('error', () => undefined);

    let exitInfo: ShellExit | null = null;
    const finish = () => {
      if (this.exited || !exitInfo) return;
      this.exited = true;
      if (this.killTimer) clearTimeout(this.killTimer);
      this.killTimer = null;
      for (const l of this.exitListeners) l(exitInfo);
    };
    child.once('exit', (code, signal) => {
      exitInfo = { exitCode: code, signal: signal ? signalNumber(signal) : undefined };
      // 'close' follows once the pipes are drained; a background job that keeps them open must not hold the terminal.
      const drain = setTimeout(finish, DRAIN_MS);
      drain.unref();
      child.once('close', () => {
        clearTimeout(drain);
        finish();
      });
    });
    // Listeners are attached right after construction; the notice goes out once they are.
    setImmediate(() => this.emit(notice));
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.push(listener);
  }

  onExit(listener: (exit: ShellExit) => void): void {
    this.exitListeners.push(listener);
  }

  private emit(data: string): void {
    if (this.exited || data.length === 0) return;
    for (const l of this.dataListeners) l(data);
  }

  write(data: string): void {
    if (this.exited) return;
    const { echo, lines, endOfInput } = this.discipline.input(data);
    this.emit(echo);
    if (canWrite(this.child)) {
      for (const line of lines) this.child.stdin.write(line + this.eol);
      if (endOfInput) this.child.stdin.end();
    }
  }

  resize(): void {
    /* pipes have no size */
  }

  pause(): void {
    this.child.stdout.pause();
    this.child.stderr.pause();
  }

  resume(): void {
    this.child.stdout.resume();
    this.child.stderr.resume();
  }

  kill(sync = false): void {
    if (this.exited || this.child.pid === undefined) return;
    const pid = this.child.pid;
    if (this.platform === 'win32') {
      terminateTree(pid, { platform: this.platform, sync });
      return;
    }
    terminateTree(pid, { platform: this.platform, signal: 'SIGHUP' });
    if (sync) {
      terminateTree(pid, { platform: this.platform, signal: 'SIGKILL' });
      return;
    }
    this.killTimer = setTimeout(() => {
      if (!this.exited) terminateTree(pid, { platform: this.platform, signal: 'SIGKILL' });
    }, KILL_GRACE_MS);
    this.killTimer.unref();
  }
}

function canWrite(child: ChildProcessWithoutNullStreams): boolean {
  return !child.stdin.destroyed && child.stdin.writable;
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
  const known: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return known[signal];
}

function spawnPipes(
  options: SpawnOptions,
  platform: NodeJS.Platform,
  notice: string,
): Promise<ShellProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.file, pipeArguments(options.kind, options.args), {
      cwd: options.cwd,
      env: { ...options.env, TERM: 'dumb' },
      stdio: 'pipe',
      windowsHide: true,
      // A process group of its own, so the whole tree can be signalled on macOS and Linux.
      detached: platform !== 'win32',
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      const code = error.code === 'ENOENT' ? 'E_NOT_FOUND' : 'E_IO';
      reject(new IncError(code, `Could not start the shell ${options.file}: ${error.message}`));
    });
    child.once('spawn', () => {
      resolve(new PipeShell(child, platform, notice));
    });
  });
}

// --- Entry point --------------------------------------------------------------------------------

export interface SpawnResult {
  shell: ShellProcess;
  /** Set when the pipe fallback was used. */
  fallbackReason?: string;
}

const FALLBACK_NOTICE =
  '\u001b[2mLimited terminal: a full terminal could not be started, so interactive programs are not available.\u001b[0m\r\n';

/**
 * Start a shell. `ptyLoader` of `null` skips the pseudo-terminal and uses pipes directly. When
 * the pseudo-terminal cannot be loaded or started, `onFallback` is told why before pipes are tried.
 */
export async function spawnShell(
  options: SpawnOptions,
  ptyLoader: PtyLoader | null = defaultPtyLoader,
  onFallback?: (reason: string, cause: unknown) => void,
): Promise<SpawnResult> {
  const platform = options.platform ?? process.platform;
  let reason = 'A pseudo-terminal was not requested.';
  let cause: unknown = null;

  if (ptyLoader) {
    try {
      const pty = await ptyLoader();
      const handle = pty.spawn(options.file, options.args, {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
      });
      return { shell: new PtyShell(handle, platform) };
    } catch (e) {
      cause = e;
      reason = `The terminal component could not start (${e instanceof Error ? e.message : String(e)}).`;
    }
  }

  onFallback?.(reason, cause);
  const shell = await spawnPipes(options, platform, FALLBACK_NOTICE);
  return { shell, fallbackReason: reason };
}
