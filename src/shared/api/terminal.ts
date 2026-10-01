export interface TerminalProfile {
  id: string;
  label: string;
  /** Executable path. */
  path: string;
  args: string[];
  isDefault: boolean;
}

export interface TerminalCreateOptions {
  cols: number;
  rows: number;
  profileId?: string;
  /** Defaults to the workspace root. */
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
}

export interface TaskDefinition {
  id: string;
  label: string;
  command: string;
  cwd: string;
  source: 'npm' | 'inc';
  detail?: string;
}

export interface TerminalInvoke {
  'terminal:listProfiles': () => TerminalProfile[];
  'terminal:create': (options: TerminalCreateOptions) => TerminalInfo;
  'terminal:write': (id: number, data: string) => void;
  'terminal:resize': (id: number, cols: number, rows: number) => void;
  'terminal:kill': (id: number) => void;
  /** Flow control: the renderer acknowledges processed output so the PTY can be paused when it falls behind. */
  'terminal:ack': (id: number, charCount: number) => void;
  /** Tasks from `.inc/tasks.json` and the `scripts` of package.json in the workspace root. */
  'tasks:list': () => TaskDefinition[];
}

export interface TerminalEvents {
  'terminal:data': { id: number; data: string };
  'terminal:exit': { id: number; exitCode: number | null; signal?: number };
  'terminal:title': { id: number; title: string };
}
