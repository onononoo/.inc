/**
 * Environment construction for terminal sessions.
 *
 * Terminals inherit the user's environment so that tools behave exactly as they do in any other
 * terminal, minus everything that would expose or disturb the application itself: Electron and
 * .inc internals, and Node.js options that would change how child Node programs start.
 */

export type EnvMap = Record<string, string | undefined>;

/** Variables that describe the host application rather than the user's environment. */
const HIDDEN_EXACT = new Set([
  'NODE_OPTIONS',
  'NODE_CHANNEL_FD',
  'NODE_UNIQUE_ID',
  'CHROME_DESKTOP',
  'CHROME_CRASHPAD_PIPE_NAME',
  'ORIGINAL_XDG_CURRENT_DESKTOP',
]);

const HIDDEN_PREFIXES = ['ELECTRON_', 'INC_'];

export function isHiddenVariable(name: string): boolean {
  const upper = name.toUpperCase();
  return HIDDEN_EXACT.has(upper) || HIDDEN_PREFIXES.some((p) => upper.startsWith(p));
}

/** A valid variable name is non-empty and contains neither "=" nor a NUL character. */
export function isValidVariableName(name: string): boolean {
  return name.length > 0 && !name.includes('=') && !name.includes('\0');
}

export interface EnvironmentOptions {
  /** Usually `process.env`. */
  base: EnvMap;
  /** Values of `terminal.env`. Must only be supplied for trusted workspaces. */
  extra?: Record<string, unknown>;
  appVersion: string;
  platform: NodeJS.Platform;
  /** Called with the name of each `extra` entry that was skipped because it is invalid. */
  onRejected?: (name: string) => void;
}

/**
 * Build the environment for a new terminal. Windows environment names are case-insensitive, so
 * merging on that platform replaces an existing name whatever its case.
 */
export function buildTerminalEnv(options: EnvironmentOptions): Record<string, string> {
  const { base, extra, appVersion, platform, onRejected } = options;
  const caseInsensitive = platform === 'win32';
  const result: Record<string, string> = {};
  const index = new Map<string, string>(); // normalised name -> name used in `result`

  const keyOf = (name: string) => (caseInsensitive ? name.toUpperCase() : name);
  const set = (name: string, value: string) => {
    const key = keyOf(name);
    const existing = index.get(key);
    if (existing !== undefined && existing !== name) delete result[existing];
    index.set(key, name);
    result[name] = value;
  };

  for (const [name, value] of Object.entries(base)) {
    if (typeof value !== 'string' || !isValidVariableName(name) || isHiddenVariable(name)) continue;
    set(name, value);
  }

  if (extra) {
    for (const [name, value] of Object.entries(extra)) {
      if (typeof value !== 'string' || !isValidVariableName(name) || value.includes('\0')) {
        onRejected?.(name);
        continue;
      }
      set(name, value);
    }
  }

  set('TERM', 'xterm-256color');
  set('COLORTERM', 'truecolor');
  set('TERM_PROGRAM', 'inc');
  set('TERM_PROGRAM_VERSION', appVersion);

  // Applications started from the Dock or Finder have no locale; shells then mis-render UTF-8.
  if (platform === 'darwin' && !index.has('LANG') && !index.has('LC_ALL')) {
    set('LANG', 'en_US.UTF-8');
  }
  return result;
}
