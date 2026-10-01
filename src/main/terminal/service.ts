/**
 * Terminal sessions for every window.
 *
 * The service knows nothing about Electron: everything it needs from the application arrives
 * through `TerminalHost`, which the slice entry point builds from the kernel. Each getter on the
 * host is read at call time, because the settings and workspace slices replace the kernel's
 * default hosts after start-up.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import type {
  TaskDefinition,
  TerminalCreateOptions,
  TerminalEvents,
  TerminalInfo,
  TerminalProfile,
} from '@shared/api/terminal';
import { IncError } from '@shared/errors';
import type { EventMap } from '@shared/ipc';
import type { PolicyFeatures } from '@shared/policy';
import type { SettingKey, SettingValues } from '@shared/settings';
import { buildTerminalEnv, type EnvMap } from './environment';
import { FlowControl } from './flow-control';
import { FrameBatcher } from './frame-batcher';
import {
  applyShellSettings,
  detectProfiles,
  type DetectionEnv,
  type ShellProfile,
} from './profiles';
import { ReadyDetector } from './ready-detector';
import {
  defaultPtyLoader,
  spawnShell,
  type PtyLoader,
  type ShellProcess,
  type SpawnResult,
} from './shell-process';
import { loadTasks } from './tasks';
import { TitleParser } from './title-parser';
import {
  clampSize,
  resolveCwd,
  validateAckCount,
  validateInitialCommand,
  validateName,
  validateSize,
  validateTerminalId,
  validateWriteData,
} from './validation';

type TerminalChannel = keyof TerminalEvents & keyof EventMap;

/** Terminals a single window may have open at once. */
export const MAX_TERMINALS_PER_WINDOW = 16;

export interface TerminalLogger {
  debug(message: string, ...meta: unknown[]): void;
  info(message: string, ...meta: unknown[]): void;
  warn(message: string, ...meta: unknown[]): void;
  error(message: string, ...meta: unknown[]): void;
}

export interface TerminalHost {
  platform: NodeJS.Platform;
  appVersion: string;
  env: EnvMap;
  logger: TerminalLogger;
  features(): PolicyFeatures;
  setting<K extends SettingKey>(windowId: number, key: K): SettingValues[K];
  isTrusted(windowId: number): boolean;
  workspaceRoot(windowId: number): string | null;
  send<K extends TerminalChannel>(windowId: number, channel: K, payload: EventMap[K]): void;
  /** Where profiles are looked for. Defaults to the real machine. */
  detection?: DetectionEnv;
  /** Loads node-pty. `null` forces the pipe fallback. Defaults to the real module. */
  ptyLoader?: PtyLoader | null;
  homeDir?: string;
}

export function systemDetection(platform: NodeJS.Platform, env: EnvMap): DetectionEnv {
  return {
    platform,
    env,
    isFile(file) {
      try {
        // lstat so that Windows app-execution aliases (reparse points that stat cannot open) count.
        return !lstatSync(file).isDirectory();
      } catch {
        return false;
      }
    },
    readText(file) {
      try {
        if (statSync(file).size > 1_048_576) return null;
        return readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
    realPath(file) {
      try {
        return realpathSync(file);
      } catch {
        return file;
      }
    },
  };
}

interface Session {
  id: number;
  windowId: number;
  info: TerminalInfo;
  shell: ShellProcess;
  flow: FlowControl;
  batcher: FrameBatcher;
  title: TitleParser;
  ready: ReadyDetector | null;
  exited: boolean;
}

export class TerminalService {
  private readonly sessions = new Map<number, Session>();
  private readonly starting = new Map<number, number>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly host: TerminalHost) {}

  // --- Gates ------------------------------------------------------------------------------------

  private assertTerminalAllowed(): void {
    if (!this.host.features().terminal) {
      throw new IncError('E_POLICY', 'The terminal is disabled by your organization.');
    }
  }

  private assertTrusted(windowId: number): void {
    if (!this.host.isTrusted(windowId)) {
      throw new IncError(
        'E_UNTRUSTED',
        'The terminal is not available in Restricted Mode. Trust this workspace to use it.',
      );
    }
  }

  private detection(): DetectionEnv {
    return this.host.detection ?? systemDetection(this.host.platform, this.host.env);
  }

  // --- Profiles ---------------------------------------------------------------------------------

  private resolveProfiles(windowId: number): { profiles: ShellProfile[]; problem: string | null } {
    const detection = this.detection();
    const detected = detectProfiles(detection);
    // Restricted settings: a shell and arguments chosen in an untrusted workspace never apply.
    const settings = this.host.isTrusted(windowId)
      ? {
          shell: this.host.setting(windowId, 'terminal.shell'),
          shellArgs: this.host.setting(windowId, 'terminal.shellArgs'),
        }
      : null;
    const resolved = applyShellSettings(detected, settings, detection);
    if (resolved.customProblem) this.host.logger.warn(resolved.customProblem);
    return { profiles: resolved.profiles, problem: resolved.customProblem };
  }

  listProfiles(windowId: number): TerminalProfile[] {
    this.assertTerminalAllowed();
    return this.resolveProfiles(windowId).profiles.map(publicProfile);
  }

  private chooseProfile(windowId: number, profileId: unknown): ShellProfile {
    if (profileId !== undefined && typeof profileId !== 'string') {
      throw new IncError('E_INVALID', 'The profile id must be text.');
    }
    const { profiles, problem } = this.resolveProfiles(windowId);
    if (profileId !== undefined) {
      const match = profiles.find((p) => p.id === profileId);
      if (!match)
        throw new IncError('E_NOT_FOUND', `There is no terminal profile named "${profileId}".`);
      return match;
    }
    if (problem)
      throw new IncError(
        'E_NOT_FOUND',
        `${problem}. Change the setting or clear it to use the system default.`,
      );
    const chosen = profiles.find((p) => p.isDefault) ?? profiles[0];
    if (!chosen) {
      throw new IncError(
        'E_NOT_FOUND',
        'No shell was found on this computer. Set one in the terminal.shell setting.',
      );
    }
    return chosen;
  }

  // --- Sessions ---------------------------------------------------------------------------------

  private countFor(windowId: number): number {
    let count = this.starting.get(windowId) ?? 0;
    for (const s of this.sessions.values()) if (s.windowId === windowId) count++;
    return count;
  }

  private owned(windowId: number, id: unknown): Session | undefined {
    const session = this.sessions.get(validateTerminalId(id));
    return session && session.windowId === windowId ? session : undefined;
  }

  async create(windowId: number, options: TerminalCreateOptions): Promise<TerminalInfo> {
    this.assertTerminalAllowed();
    this.assertTrusted(windowId);
    if (this.disposed) throw new IncError('E_CANCELLED', 'The application is closing.');
    if (typeof options !== 'object' || options === null) {
      throw new IncError('E_INVALID', 'Terminal options are required.');
    }

    const { cols, rows } = validateSize(options.cols, options.rows);
    const name = validateName(options.name);
    const initialCommand = validateInitialCommand(options.initialCommand);
    const profile = this.chooseProfile(windowId, options.profileId);
    const fallbackCwd = this.host.workspaceRoot(windowId) ?? this.host.homeDir ?? os.homedir();
    const cwd = await resolveCwd(options.cwd, fallbackCwd);

    // Checked after the awaits above, and counting terminals still starting, so concurrent
    // creates cannot slip past the limit.
    if (this.countFor(windowId) >= MAX_TERMINALS_PER_WINDOW) {
      throw new IncError(
        'E_INVALID',
        `A window can have at most ${MAX_TERMINALS_PER_WINDOW} terminals. Close one to open another.`,
        { limit: MAX_TERMINALS_PER_WINDOW },
      );
    }
    this.starting.set(windowId, (this.starting.get(windowId) ?? 0) + 1);

    const extraEnv = this.host.setting(windowId, 'terminal.env');
    const env = buildTerminalEnv({
      base: this.host.env,
      extra: extraEnv,
      appVersion: this.host.appVersion,
      platform: this.host.platform,
      onRejected: (variable) =>
        this.host.logger.warn(`Ignored invalid terminal.env entry "${variable}".`),
    });

    let spawned: SpawnResult;
    try {
      spawned = await spawnShell(
        {
          file: profile.path,
          args: profile.args,
          kind: profile.kind,
          cwd,
          env,
          cols,
          rows,
          platform: this.host.platform,
        },
        this.host.ptyLoader === undefined ? defaultPtyLoader : this.host.ptyLoader,
        (reason, cause) =>
          this.host.logger.warn(`Using the pipe fallback for terminals. ${reason}`, cause),
      );
    } finally {
      const remaining = (this.starting.get(windowId) ?? 1) - 1;
      if (remaining > 0) this.starting.set(windowId, remaining);
      else this.starting.delete(windowId);
    }
    const { shell, fallbackReason } = spawned;

    if (this.disposed) {
      shell.kill(true);
      throw new IncError('E_CANCELLED', 'The application is closing.');
    }

    const id = this.nextId++;

    const info: TerminalInfo = {
      id,
      pid: shell.pid,
      name: name ?? profile.label,
      cwd,
      profile: publicProfile(profile),
      isPty: shell.isPty,
      ...(fallbackReason ? { fallbackReason } : {}),
    };
    this.attach(windowId, info, shell, initialCommand);
    this.host.logger.info(
      `Terminal ${id} started: ${profile.id}, pid ${shell.pid}, ${shell.isPty ? 'pty' : 'pipes'}`,
    );
    return info;
  }

  private attach(
    windowId: number,
    info: TerminalInfo,
    shell: ShellProcess,
    initialCommand?: string,
  ): void {
    const id = info.id;
    const flow = new FlowControl();
    const batcher = new FrameBatcher((data) => {
      this.host.send(windowId, 'terminal:data', { id, data });
      if (flow.sent(data.length) === 'pause') shell.pause();
    });
    const session: Session = {
      id,
      windowId,
      info,
      shell,
      flow,
      batcher,
      title: new TitleParser(),
      ready: null,
      exited: false,
    };
    this.sessions.set(id, session);

    if (initialCommand) {
      // The pseudo-terminal queues early input, so this only waits for the prompt to settle for
      // tidy output. Pipes have no prompt: the shell reads the line as soon as it starts.
      const write = () => {
        if (!session.exited) shell.write(`${initialCommand}\r`);
      };
      if (shell.isPty) session.ready = new ReadyDetector(write);
      else write();
    }

    shell.onData((data) => {
      session.ready?.activity();
      batcher.push(data);
      for (const title of session.title.feed(data)) {
        this.host.send(windowId, 'terminal:title', { id, title });
      }
    });

    shell.onExit((exit) => {
      session.exited = true;
      session.ready?.cancel();
      batcher.flush();
      batcher.dispose();
      this.sessions.delete(id);
      this.host.send(windowId, 'terminal:exit', {
        id,
        exitCode: exit.exitCode,
        ...(exit.signal ? { signal: exit.signal } : {}),
      });
      this.host.logger.info(`Terminal ${id} exited with code ${exit.exitCode ?? 'none'}`);
    });
  }

  write(windowId: number, id: number, data: string): void {
    this.assertTerminalAllowed();
    const text = validateWriteData(data);
    const session = this.owned(windowId, id);
    if (!session) throw new IncError('E_NOT_FOUND', 'That terminal has already closed.');
    session.shell.write(text);
  }

  resize(windowId: number, id: number, cols: number, rows: number): void {
    this.assertTerminalAllowed();
    const size = clampSize(cols, rows);
    this.owned(windowId, id)?.shell.resize(size.cols, size.rows);
  }

  kill(windowId: number, id: number): void {
    this.assertTerminalAllowed();
    this.owned(windowId, id)?.shell.kill();
  }

  ack(windowId: number, id: number, charCount: number): void {
    this.assertTerminalAllowed();
    const count = validateAckCount(charCount);
    const session = this.owned(windowId, id);
    if (session && session.flow.acknowledge(count) === 'resume') session.shell.resume();
  }

  // --- Tasks ------------------------------------------------------------------------------------

  async listTasks(windowId: number): Promise<TaskDefinition[]> {
    const features = this.host.features();
    if (!features.tasks || !features.terminal) return [];
    if (!this.host.isTrusted(windowId)) return [];
    const root = this.host.workspaceRoot(windowId);
    if (!root) return [];
    const { tasks, issues } = await loadTasks(root);
    for (const issue of issues) this.host.logger.warn(`Tasks: ${issue}`);
    return tasks;
  }

  // --- Lifetime ---------------------------------------------------------------------------------

  /** Stop every terminal that belongs to a window (the window was closed). */
  disposeWindow(windowId: number, sync = false): void {
    for (const session of [...this.sessions.values()]) {
      if (session.windowId !== windowId) continue;
      this.release(session, sync);
    }
  }

  /** Stop every terminal and refuse new ones. Waits for the processes to end when `sync`. */
  dispose(sync = false): void {
    this.disposed = true;
    for (const session of [...this.sessions.values()]) this.release(session, sync);
  }

  private release(session: Session, sync: boolean): void {
    session.ready?.cancel();
    session.batcher.dispose();
    this.sessions.delete(session.id);
    try {
      session.shell.kill(sync);
    } catch (e) {
      this.host.logger.warn(`Could not stop terminal ${session.id}`, e);
    }
  }

  /** Number of live terminals, for tests and diagnostics. */
  get size(): number {
    return this.sessions.size;
  }
}

function publicProfile(profile: ShellProfile): TerminalProfile {
  return {
    id: profile.id,
    label: profile.label,
    path: profile.path,
    args: [...profile.args],
    isDefault: profile.isDefault,
  };
}
