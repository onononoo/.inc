export interface TerminalProfile {
  /** Stable across runs: `pwsh`, `powershell`, `cmd`, `git-bash`, or the executable name (`zsh`, `bash`). `custom` is the shell set in `terminal.shell`. */
  id: string;
  label: string;
  /** Executable path. */
  path: string;
  args: string[];
  isDefault: boolean;
}

export interface TerminalCreateOptions {
  /** Whole numbers from 1 to 1000. */
  cols: number;
  /** Whole numbers from 1 to 500. */
  rows: number;
  /** Defaults to the profile chosen by `terminal.shell`, else the first detected profile. */
  profileId?: string;
  /** Absolute path of an existing folder. Defaults to the workspace root. */
  cwd?: string;
  name?: string;
  /** Written to the shell once it has started, followed by Enter. Used to run tasks. */
  initialCommand?: string;
}

export interface TerminalInfo {
  id: number;
  pid: number;
  name: string;
  cwd: string;
  profile: TerminalProfile;
  /** False when a real PTY was unavailable and a pipe fallback is in use (no interactive full-screen programs). */
  isPty: boolean;
  /** Plain-language explanation of why the pipe fallback is in use. Present only when `isPty` is false. */
  fallbackReason?: string;
}

export interface TaskDefinition {
  /** Stable: `npm:<script>` for package scripts, `inc:<label>` for tasks.json entries. */
  id: string;
  label: string;
  command: string;
  /** Absolute path. */
  cwd: string;
  source: 'npm' | 'inc';
  detail?: string;
}

/**
 * Every `terminal:*` channel rejects with E_POLICY when the administrator policy disables the
 * terminal. `terminal:create` also rejects with E_UNTRUSTED in an untrusted workspace.
 * Ids belong to the window that created them: another window's id behaves as an unknown id.
 */
export interface TerminalInvoke {
  'terminal:listProfiles': () => TerminalProfile[];
  /**
   * Rejects with E_INVALID (bad size, name, command, cwd not absolute, or too many terminals),
   * E_NOT_FOUND (unknown profile, missing cwd or shell), E_NOT_DIRECTORY or E_IO.
   */
  'terminal:create': (options: TerminalCreateOptions) => TerminalInfo;
  /** Rejects with E_NOT_FOUND when the terminal has already exited. */
  'terminal:write': (id: number, data: string) => void;
  /** Sizes are clamped to the supported range. Ignored when the terminal has already exited. */
  'terminal:resize': (id: number, cols: number, rows: number) => void;
  /** Stops the shell and everything it started. Ignored when the terminal has already exited. */
  'terminal:kill': (id: number) => void;
  /** Flow control: the renderer acknowledges processed output so the PTY can be paused when it falls behind. */
  'terminal:ack': (id: number, charCount: number) => void;
  /**
   * Tasks from `.inc/tasks.json` and the `scripts` of package.json in the workspace root.
   * Empty (never an error) when tasks or the terminal are disabled by policy or the workspace is untrusted.
   */
  'tasks:list': () => TaskDefinition[];
}

export interface TerminalEvents {
  'terminal:data': { id: number; data: string };
  'terminal:exit': { id: number; exitCode: number | null; signal?: number };
  'terminal:title': { id: number; title: string };
}
