/**
 * Pure settings logic: parse a settings file and resolve the layers
 * (defaults < user < workspace < policy) into a snapshot. No file system access here.
 */
import { getNodeValue } from 'jsonc-parser';
import type { SettingSource, SettingsIssue, SettingsSnapshot } from '@shared/api/settings';
import type { PolicyState } from '@shared/policy';
import {
  SETTINGS,
  SETTING_KEYS,
  cloneValue,
  defaultSettings,
  isMergedType,
  isSettingKey,
  validateSetting,
  type SettingKey,
  type SettingValues,
} from '@shared/settings';
import { describeProblem, lineOfNode, lineStarts, parseDocument } from './jsonc';

export interface ParsedEntry {
  value: unknown;
  /** 1-based line of the entry in its file. */
  line: number;
}

export interface ParsedSettingsFile {
  entries: Map<string, ParsedEntry>;
  /** Structural problems: syntax errors, wrong top-level type, duplicate keys. */
  issues: SettingsIssue[];
  /** True when the text could not be parsed; the caller keeps the previous entries. */
  syntaxError: boolean;
}

/** Parse the text of a settings file. `text` is null for a file that does not exist. */
export function parseSettingsFile(text: string | null, file: string): ParsedSettingsFile {
  const entries = new Map<string, ParsedEntry>();
  const issues: SettingsIssue[] = [];
  if (text === null) return { entries, issues, syntaxError: false };

  const doc = parseDocument(text);
  if (doc.problems.length > 0) {
    for (const problem of doc.problems) {
      issues.push({
        file,
        line: problem.line,
        message: `${describeProblem(problem)} The previous settings stay in effect until this is fixed.`,
      });
    }
    return { entries, issues, syntaxError: true };
  }
  if (!doc.root) return { entries, issues, syntaxError: false };
  if (doc.root.type !== 'object') {
    issues.push({
      file,
      line: 1,
      message: 'The file must contain a single object, for example { "editor.fontSize": 14 }.',
    });
    return { entries, issues, syntaxError: true };
  }

  const starts = lineStarts(text);
  for (const property of doc.root.children ?? []) {
    const keyNode = property.children?.[0];
    const valueNode = property.children?.[1];
    if (!keyNode || !valueNode || typeof keyNode.value !== 'string') continue;
    const key = keyNode.value;
    const line = lineOfNode(starts, keyNode);
    if (entries.has(key)) {
      issues.push({
        file,
        line,
        key,
        message: `"${key}" appears more than once. The last value is used.`,
      });
    }
    entries.set(key, { value: getNodeValue(valueNode), line });
  }
  return { entries, issues, syntaxError: false };
}

export interface LayerInput {
  file: string;
  entries: ReadonlyMap<string, ParsedEntry>;
  /** Structural issues carried over from parsing. */
  issues: readonly SettingsIssue[];
}

interface ValidatedLayer {
  values: Record<string, unknown>;
  issues: SettingsIssue[];
  restrictedIgnored: SettingKey[];
}

function validateLayer(
  layer: LayerInput,
  kind: 'user' | 'workspace',
  trusted: boolean,
): ValidatedLayer {
  const values: Record<string, unknown> = {};
  const issues: SettingsIssue[] = [...layer.issues];
  const restrictedIgnored: SettingKey[] = [];

  for (const [key, entry] of layer.entries) {
    const at = { file: layer.file, line: entry.line, key };
    if (!isSettingKey(key)) {
      issues.push({ ...at, message: `Unknown setting "${key}". It was ignored.` });
      continue;
    }
    const def = SETTINGS[key];
    const result = validateSetting(key, entry.value);
    if (!result.ok) {
      issues.push({ ...at, message: `Invalid value for "${key}": ${result.reason} It was ignored.` });
      continue;
    }
    if (kind === 'workspace') {
      if (def.scope === 'user') {
        issues.push({
          ...at,
          message: `"${key}" can only be set in your user settings, so the workspace value was ignored.`,
        });
        continue;
      }
      if (def.restricted && !trusted) {
        restrictedIgnored.push(key);
        continue;
      }
    }
    Object.defineProperty(values, key, {
      value: result.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { values, issues, restrictedIgnored };
}

export interface ResolveInput {
  user: LayerInput;
  /** Null when the window has no folder open. */
  workspace: LayerInput | null;
  trusted: boolean;
  policy: PolicyState;
  /** Path of the (possibly not yet existing) workspace file, when a folder is open. */
  workspaceFile: string | null;
}

/** Merge two record values key by key; later entries win, including `false` over `true`. */
function mergeRecords(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries([...Object.entries(base), ...Object.entries(over)]);
}

export function resolveSettings(input: ResolveInput): SettingsSnapshot {
  const user = validateLayer(input.user, 'user', true);
  const workspace = input.workspace
    ? validateLayer(input.workspace, 'workspace', input.trusted)
    : { values: {}, issues: [], restrictedIgnored: [] as SettingKey[] };
  const policyValues = input.policy.values as Record<string, unknown>;
  const locked = input.policy.lockedKeys.filter((k) => isSettingKey(k));

  const effective = defaultSettings() as unknown as Record<string, unknown>;
  const sources = {} as Record<SettingKey, SettingSource>;

  for (const key of SETTING_KEYS) {
    const def = SETTINGS[key];
    let source: SettingSource = 'default';
    let value: unknown = effective[key];
    const layers: ['user' | 'workspace', Record<string, unknown>][] = [
      ['user', user.values],
      ['workspace', workspace.values],
    ];
    for (const [name, values] of layers) {
      if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
      const next = values[key];
      value =
        isMergedType(def.type) && isPlainRecord(value) && isPlainRecord(next)
          ? mergeRecords(value, next)
          : cloneValue(next);
      source = name;
    }
    if (locked.includes(key) && Object.prototype.hasOwnProperty.call(policyValues, key)) {
      value = cloneValue(policyValues[key]);
      source = 'policy';
    }
    effective[key] = value;
    sources[key] = source;
  }

  return {
    effective: effective as unknown as SettingValues,
    sources,
    user: user.values as Partial<SettingValues>,
    workspace: workspace.values as Partial<SettingValues>,
    locked,
    restrictedIgnored: workspace.restrictedIgnored,
    issues: [...user.issues, ...workspace.issues],
    files: {
      user: input.user.file,
      workspace: input.workspaceFile,
      policy: input.policy.file,
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keys whose effective value or source differs between two snapshots. */
export function changedKeys(before: SettingsSnapshot, after: SettingsSnapshot): SettingKey[] {
  const out: SettingKey[] = [];
  for (const key of SETTING_KEYS) {
    if (
      before.sources[key] !== after.sources[key] ||
      JSON.stringify(before.effective[key]) !== JSON.stringify(after.effective[key])
    ) {
      out.push(key);
    }
  }
  return out;
}
