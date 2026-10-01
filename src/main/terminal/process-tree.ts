/**
 * Stopping a shell together with everything it started.
 *
 * Windows: `taskkill /T /F` walks the whole tree. macOS and Linux: the shell is the leader of its
 * own process group (a PTY child calls setsid, a pipe child is spawned detached), so signalling
 * the negative pid reaches every job it started.
 */
import { execFile, execFileSync } from 'node:child_process';

export type TerminationSignal = 'SIGHUP' | 'SIGTERM' | 'SIGKILL';

/** How long a shell may take to exit after SIGHUP before it is killed outright. */
export const KILL_GRACE_MS = 3_000;

function isGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

/**
 * Terminate `pid` and its descendants. `sync` waits for completion (used while the application
 * is quitting); otherwise the call returns immediately. A process that is already gone is not an
 * error.
 */
export function terminateTree(
  pid: number,
  options: { platform?: NodeJS.Platform; signal?: TerminationSignal; sync?: boolean } = {},
): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const platform = options.platform ?? process.platform;

  if (platform === 'win32') {
    const args = ['/PID', String(pid), '/T', '/F'];
    if (options.sync) {
      try {
        execFileSync('taskkill', args, { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
      } catch {
        /* exit code 128 means the process had already ended */
      }
    } else {
      execFile('taskkill', args, { windowsHide: true }, () => undefined);
    }
    return;
  }

  const signal = options.signal ?? 'SIGHUP';
  try {
    process.kill(-pid, signal);
  } catch (groupError) {
    if (isGone(groupError)) return;
    try {
      process.kill(pid, signal);
    } catch (e) {
      if (!isGone(e)) throw e;
    }
  }
}
