/**
 * Tasks: entries from `<root>/.inc/tasks.json` and the `scripts` of the root package.json.
 *
 * Nothing here runs anything. Problems in a file are collected as issues (the caller logs them)
 * and the offending entry is skipped, so one mistake never hides the other tasks.
 */
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { TaskDefinition } from '@shared/api/terminal';

export const TASKS_FILE = '.inc/tasks.json';
const MAX_FILE_BYTES = 1_048_576;
const MAX_LABEL = 200;
const MAX_COMMAND = 8_192;
const MAX_DETAIL = 120;

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Lock files in the order they take precedence. */
const LOCK_FILES: readonly (readonly [string, PackageManager])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/**
 * Script names are placed in a shell command line, so only names that need no quoting and cannot
 * be read as an option are accepted.
 */
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9_.:@/][A-Za-z0-9_.:@/-]*$/;

export interface TaskParseResult {
  tasks: TaskDefinition[];
  issues: string[];
}

/** Package manager from the lock files present, then the `packageManager` field, else npm. */
export function detectPackageManager(
  files: ReadonlySet<string>,
  packageManagerField?: unknown,
): PackageManager {
  for (const [file, manager] of LOCK_FILES) {
    if (files.has(file)) return manager;
  }
  if (typeof packageManagerField === 'string') {
    const name = packageManagerField.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  }
  return 'npm';
}

function describeParseErrors(errors: ParseError[], text: string): string {
  const first = errors[0]!;
  const line = text.slice(0, first.offset).split('\n').length;
  return `${printParseErrorCode(first.error)} on line ${line}`;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

/** True when `target` is `root` or lies inside it. */
function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Parse the text of `.inc/tasks.json`. A relative `cwd` is resolved against the workspace root
 * and `${workspaceFolder}` is replaced by it; a `cwd` outside the root is rejected.
 */
export function parseTasksFile(text: string, root: string): TaskParseResult {
  const tasks: TaskDefinition[] = [];
  const issues: string[] = [];

  const errors: ParseError[] = [];
  const document: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    issues.push(`${TASKS_FILE}: ${describeParseErrors(errors, text)}.`);
    return { tasks, issues };
  }
  if (!isRecord(document) || !Array.isArray(document.tasks)) {
    issues.push(`${TASKS_FILE}: expected an object with a "tasks" array.`);
    return { tasks, issues };
  }

  const usedIds = new Set<string>();
  document.tasks.forEach((entry: unknown, index: number) => {
    const where = `${TASKS_FILE}: task ${index + 1}`;
    if (!isRecord(entry)) {
      issues.push(`${where} must be an object.`);
      return;
    }
    const { label, command, cwd } = entry;
    if (typeof label !== 'string' || label.trim() === '' || label.length > MAX_LABEL) {
      issues.push(`${where} needs a "label" of 1 to ${MAX_LABEL} characters.`);
      return;
    }
    if (hasControlCharacters(label)) {
      issues.push(`${where} has a "label" with control characters.`);
      return;
    }
    if (
      typeof command !== 'string' ||
      command.trim() === '' ||
      command.length > MAX_COMMAND ||
      /[\r\n\0]/.test(command)
    ) {
      issues.push(
        `${where} ("${label}") needs a single-line "command" of up to ${MAX_COMMAND} characters.`,
      );
      return;
    }

    let taskCwd = root;
    if (cwd !== undefined) {
      if (typeof cwd !== 'string' || cwd.trim() === '' || cwd.includes('\0')) {
        issues.push(`${where} ("${label}") has an invalid "cwd".`);
        return;
      }
      const substituted = cwd.replace(/\$\{workspaceFolder\}/g, root);
      taskCwd = path.resolve(root, substituted);
      if (!isInside(root, taskCwd)) {
        issues.push(`${where} ("${label}") has a "cwd" outside the workspace folder.`);
        return;
      }
    }

    const trimmed = label.trim();
    let id = `inc:${trimmed}`;
    for (let n = 2; usedIds.has(id); n++) id = `inc:${trimmed}#${n}`;
    usedIds.add(id);
    tasks.push({
      id,
      label: trimmed,
      command: command.trim(),
      cwd: taskCwd,
      source: 'inc',
      detail: TASKS_FILE,
    });
  });
  return { tasks, issues };
}

/** Tasks for each script in the text of a package.json. */
export function parsePackageScripts(
  text: string,
  root: string,
  manager: PackageManager,
): TaskParseResult {
  const tasks: TaskDefinition[] = [];
  const issues: string[] = [];

  let document: unknown;
  try {
    document = JSON.parse(stripBom(text));
  } catch (e) {
    issues.push(`package.json: ${e instanceof Error ? e.message : 'invalid JSON'}.`);
    return { tasks, issues };
  }
  if (!isRecord(document) || document.scripts === undefined) return { tasks, issues };
  if (!isRecord(document.scripts)) {
    issues.push('package.json: "scripts" must be an object.');
    return { tasks, issues };
  }

  for (const [name, body] of Object.entries(document.scripts)) {
    if (typeof body !== 'string') {
      issues.push(`package.json: script "${name}" must be text.`);
      continue;
    }
    if (!SAFE_SCRIPT_NAME.test(name)) {
      issues.push(
        `package.json: script "${name}" has a name that cannot be run safely and was skipped.`,
      );
      continue;
    }
    tasks.push({
      id: `npm:${name}`,
      label: name,
      command: `${manager} run ${name}`,
      cwd: root,
      source: 'npm',
      detail: body.length > MAX_DETAIL ? `${body.slice(0, MAX_DETAIL - 1)}…` : body,
    });
  }
  return { tasks, issues };
}

async function readSmallFile(file: string): Promise<{ text: string } | { issue: string } | null> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    if (info.size > MAX_FILE_BYTES) return { issue: `${path.basename(file)} is larger than 1 MB.` };
    return { text: await readFile(file, 'utf8') };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { issue: `${path.basename(file)} could not be read: ${(e as Error).message}` };
  }
}

async function existingFiles(root: string): Promise<Set<string>> {
  const present = new Set<string>();
  await Promise.all(
    LOCK_FILES.map(async ([name]) => {
      try {
        if ((await stat(path.join(root, name))).isFile()) present.add(name);
      } catch {
        /* not present */
      }
    }),
  );
  return present;
}

/** Read both task sources for a workspace root. Tasks from `.inc/tasks.json` come first. */
export async function loadTasks(root: string): Promise<TaskParseResult> {
  const tasks: TaskDefinition[] = [];
  const issues: string[] = [];

  const tasksFile = await readSmallFile(path.join(root, '.inc', 'tasks.json'));
  if (tasksFile && 'issue' in tasksFile) issues.push(tasksFile.issue);
  else if (tasksFile) {
    const parsed = parseTasksFile(tasksFile.text, root);
    tasks.push(...parsed.tasks);
    issues.push(...parsed.issues);
  }

  const packageFile = await readSmallFile(path.join(root, 'package.json'));
  if (packageFile && 'issue' in packageFile) issues.push(packageFile.issue);
  else if (packageFile) {
    let field: unknown;
    try {
      const parsed: unknown = JSON.parse(stripBom(packageFile.text));
      field = isRecord(parsed) ? parsed.packageManager : undefined;
    } catch {
      field = undefined;
    }
    const manager = detectPackageManager(await existingFiles(root), field);
    const scripts = parsePackageScripts(packageFile.text, root, manager);
    tasks.push(...scripts.tasks);
    issues.push(...scripts.issues);
  }
  return { tasks, issues };
}
