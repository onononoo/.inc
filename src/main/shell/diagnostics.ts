/**
 * Plain-text support report. Pure: everything it prints is passed in.
 *
 * The report holds versions, platform and configuration counts only. It never includes file
 * contents, workspace paths, host name or user name; the user's home directory is replaced by "~".
 */

export interface DiagnosticsInput {
  generatedAt: Date;
  app: { name: string; version: string; packaged: boolean };
  versions: { electron: string; chrome: string; node: string };
  system: {
    platform: string;
    arch: string;
    osType: string;
    osRelease: string;
    locale: string;
    cpuCount: number;
    totalMemoryBytes: number;
  };
  policy: {
    active: boolean;
    file: string | null;
    lockedKeyCount: number;
    warnings: readonly string[];
    externalLinks: string;
    terminal: boolean;
    tasks: boolean;
    gitRemoteOperations: boolean;
  };
  /** Number of settings supplied by each layer, or null when the settings service has no snapshot. */
  settingSources: Record<'default' | 'user' | 'workspace' | 'policy', number> | null;
  settingIssueCount: number | null;
  blockedNetworkRequests: number;
  userDataDir: string;
  logDir: string;
  windowCount: number;
  /** The user's home directory, masked wherever it appears. */
  homeDir: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the home directory with "~" in every spelling it can appear in (native, forward
 * slashes, JSON-escaped backslashes), case-insensitively so Windows drive letters and folder
 * case do not matter. Only whole path segments match, so "/home/al" does not mask "/home/alice".
 */
export function maskHomeDirectory(text: string, homeDir: string): string {
  const trimmed = homeDir.replace(/[\\/]+$/, '');
  if (trimmed.length < 2) return text;
  const forms = new Set<string>([
    trimmed,
    trimmed.replace(/\\/g, '/'),
    trimmed.replace(/\//g, '\\'),
    trimmed.replace(/\\/g, '\\\\'),
  ]);
  const alternatives = [...forms]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  const pattern = new RegExp(`(?:${alternatives})(?![\\p{L}\\p{N}_.-])`, 'giu');
  return text.replace(pattern, '~');
}

function formatMemory(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib >= 10 ? Math.round(gib) : gib.toFixed(1)} GB`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  const { app, versions, system, policy } = input;
  const lines: string[] = [];
  const add = (line = '') => lines.push(line);

  add(`${app.name} diagnostics`);
  add(`Generated: ${input.generatedAt.toISOString()}`);
  add();
  add('Application');
  add(`  Version: ${app.version} (${app.packaged ? 'packaged' : 'development build'})`);
  add(`  Electron: ${versions.electron}`);
  add(`  Chromium: ${versions.chrome}`);
  add(`  Node.js: ${versions.node}`);
  add(`  Open windows: ${input.windowCount}`);
  add();
  add('System');
  add(`  Platform: ${system.platform} ${system.arch}`);
  add(`  OS: ${system.osType} ${system.osRelease}`);
  add(`  Locale: ${system.locale}`);
  add(`  Processors: ${system.cpuCount}`);
  add(`  Memory: ${formatMemory(system.totalMemoryBytes)}`);
  add();
  add('Managed configuration');
  add(`  Policy active: ${yesNo(policy.active)}`);
  add(`  Policy file: ${policy.file ?? 'none'}`);
  add(`  Locked settings: ${policy.lockedKeyCount}`);
  add(`  External links: ${policy.externalLinks}`);
  add(`  Terminal: ${policy.terminal ? 'enabled' : 'disabled'}`);
  add(`  Tasks: ${policy.tasks ? 'enabled' : 'disabled'}`);
  add(`  Git remote operations: ${policy.gitRemoteOperations ? 'enabled' : 'disabled'}`);
  add(`  Policy warnings: ${policy.warnings.length}`);
  for (const warning of policy.warnings.slice(0, 20)) add(`    - ${warning.replace(/\s+/g, ' ')}`);
  if (policy.warnings.length > 20) add(`    - and ${policy.warnings.length - 20} more`);
  add();
  add('Settings');
  if (input.settingSources) {
    const s = input.settingSources;
    add(
      `  Value sources: default ${s.default}, user ${s.user}, workspace ${s.workspace}, policy ${s.policy}`,
    );
    add(`  Settings problems: ${input.settingIssueCount ?? 0}`);
  } else {
    add('  Not available yet');
  }
  add();
  add('Network');
  add(`  Blocked requests: ${input.blockedNetworkRequests}`);
  add();
  add('Storage');
  add(`  User data: ${input.userDataDir}`);
  add(`  Logs: ${input.logDir}`);

  return maskHomeDirectory(lines.join('\n') + '\n', input.homeDir);
}
