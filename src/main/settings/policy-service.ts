/**
 * Enterprise policy: locating, parsing, validating and watching the administrator policy file.
 *
 * Fail-safe rules (documented for administrators in docs/ADMIN.md):
 *  - file missing                 -> no policy;
 *  - file present, version != 1   -> warning, policy inactive;
 *  - file present, unusable       -> keep the last good policy; at startup (nothing to keep) apply
 *                                    the most restrictive features and report a warning;
 *  - invalid entries inside a readable file are ignored one by one and reported as warnings.
 */
import path from 'node:path';
import { getNodeValue } from 'jsonc-parser';
import {
  DEFAULT_POLICY_FEATURES,
  EMPTY_POLICY,
  type PolicyFeatures,
  type PolicyState,
} from '@shared/policy';
import {
  SETTING_KEYS,
  cloneValue,
  isSettingKey,
  validateSetting,
  type SettingKey,
  type SettingValues,
} from '@shared/settings';
import { Emitter, type Logger, type PolicyHost, type Unsubscribe } from '../kernel';
import { readConfigText } from './fs-util';
import { parseDocument, describeProblem } from './jsonc';
import { watchFile, type FileWatcher } from './watcher';

export const POLICY_VERSION = 1;
export const NOTICE_MAX_LENGTH = 500;

export const RESTRICTIVE_FEATURES: PolicyFeatures = {
  terminal: false,
  tasks: false,
  gitRemoteOperations: false,
  externalLinks: 'deny',
};

const EXTERNAL_LINK_MODES: readonly string[] = ['allow', 'prompt', 'deny'];
const KNOWN_TOP_LEVEL = new Set(['version', 'settings', 'features', 'notice']);
const BOOLEAN_FEATURES = ['terminal', 'tasks', 'gitRemoteOperations'] as const;

export interface PolicyPathInput {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  isPackaged: boolean;
}

export interface PolicyPathResolution {
  file: string;
  source: 'environment' | 'default';
  /** Set when INC_POLICY_FILE was present but not honoured. */
  ignoredOverride?: string;
}

/** The platform's machine-wide policy location. */
export function defaultPolicyPath(platform: NodeJS.Platform, env: PolicyPathInput['env']): string {
  if (platform === 'win32') {
    const base = env.ProgramData || env.ALLUSERSPROFILE || 'C:\\ProgramData';
    return path.win32.join(base, '.inc', 'policy.json');
  }
  if (platform === 'darwin') return '/Library/Application Support/.inc/policy.json';
  return '/etc/inc/policy.json';
}

/**
 * INC_POLICY_FILE relocates the policy file for testing and staged rollouts. Packaged builds
 * ignore it: an environment variable is under the user's control, so honouring it there would let
 * anyone point the app at an empty policy.
 */
export function resolvePolicyPath(input: PolicyPathInput): PolicyPathResolution {
  const override = input.env.INC_POLICY_FILE?.trim();
  const platformPath = input.platform === 'win32' ? path.win32 : path.posix;
  if (override && !input.isPackaged) {
    return { file: platformPath.resolve(override), source: 'environment' };
  }
  const file = defaultPolicyPath(input.platform, input.env);
  return override
    ? { file, source: 'default', ignoredOverride: override }
    : { file, source: 'default' };
}

/** Control, invisible and bidirectional-override characters have no place in a notice. */
function isUnsafeCodePoint(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/** Plain text only: no control or bidirectional-override characters, no markup, at most 500 characters. */
export function sanitizeNotice(value: string): string {
  let text = '';
  for (const char of value.replace(/<\/?[A-Za-z][^>]*>/g, ' ')) {
    text += isUnsafeCodePoint(char.codePointAt(0) ?? 0) ? ' ' : char;
  }
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length <= NOTICE_MAX_LENGTH
    ? cleaned
    : chars.slice(0, NOTICE_MAX_LENGTH - 1).join('') + '…';
}

/** The state when no policy applies. A fresh object, so freezing it never touches shared constants. */
function inactivePolicy(file: string | null = null, warnings: string[] = []): PolicyState {
  return {
    ...EMPTY_POLICY,
    file,
    features: { ...DEFAULT_POLICY_FEATURES },
    lockedKeys: [],
    values: {},
    warnings,
  };
}

/** Policy is read-only for everyone who receives it: a slice cannot weaken it by accident. */
function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) freezeDeep(inner);
    Object.freeze(value);
  }
  return value;
}

export interface PolicyParseResult {
  /** False when the document could not be parsed at all. */
  usable: boolean;
  state: PolicyState;
  /** Why the document is unusable. */
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** State applied when a policy file exists but cannot be used and there is no earlier policy. */
export function restrictivePolicy(file: string, reason: string): PolicyState {
  return {
    active: true,
    file,
    notice:
      'Your organization\u2019s policy file could not be read, so restrictive defaults are in effect. Contact your IT administrator.',
    features: { ...RESTRICTIVE_FEATURES },
    lockedKeys: [],
    values: {},
    warnings: [unusableWarning(file, reason, 'Restrictive defaults are in effect.')],
  };
}

function unusableWarning(file: string, reason: string, consequence: string): string {
  return `The policy file ${file} could not be used: ${reason} ${consequence}`;
}

/** Parse the text of a policy file. Never throws. */
export function parsePolicy(text: string, file: string): PolicyParseResult {
  const unusable = (reason: string): PolicyParseResult => ({
    usable: false,
    reason,
    state: restrictivePolicy(file, reason),
  });

  const doc = parseDocument(text);
  const first = doc.problems[0];
  if (first) return unusable(describeProblem(first));
  if (!doc.root) return unusable('The file is empty.');
  if (doc.root.type !== 'object') return unusable('The top level must be an object.');
  const raw = getNodeValue(doc.root) as unknown;
  if (!isRecord(raw)) return unusable('The top level must be an object.');

  if (raw.version !== POLICY_VERSION) {
    return {
      usable: true,
      state: inactivePolicy(file, [
        `The policy file ${file} has version ${JSON.stringify(raw.version ?? null)} but this version of .inc supports version ${POLICY_VERSION}. The policy is inactive.`,
      ]),
    };
  }

  const warnings: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL.has(key)) warnings.push(`Unknown policy field "${key}" was ignored.`);
  }

  const values: Record<string, unknown> = {};
  const lockedKeys: SettingKey[] = [];
  if (raw.settings !== undefined) {
    if (!isRecord(raw.settings)) {
      warnings.push('"settings" must be an object, so it was ignored.');
    } else {
      for (const [key, value] of Object.entries(raw.settings)) {
        if (!isSettingKey(key)) {
          warnings.push(`Setting "${key}" is not a known setting, so it was ignored.`);
          continue;
        }
        const result = validateSetting(key, value);
        if (!result.ok) {
          warnings.push(`Setting "${key}" was ignored: ${result.reason}`);
          continue;
        }
        Object.defineProperty(values, key, {
          value: cloneValue(result.value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      for (const key of SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(values, key)) lockedKeys.push(key);
      }
    }
  }

  const features: PolicyFeatures = { ...DEFAULT_POLICY_FEATURES };
  if (raw.features !== undefined) {
    if (!isRecord(raw.features)) {
      warnings.push('"features" must be an object, so it was ignored.');
    } else {
      for (const [name, value] of Object.entries(raw.features)) {
        if ((BOOLEAN_FEATURES as readonly string[]).includes(name)) {
          if (typeof value === 'boolean') {
            features[name as (typeof BOOLEAN_FEATURES)[number]] = value;
          } else {
            warnings.push(`Feature "${name}" must be true or false, so it was ignored.`);
          }
        } else if (name === 'externalLinks') {
          if (typeof value === 'string' && EXTERNAL_LINK_MODES.includes(value)) {
            features.externalLinks = value as PolicyFeatures['externalLinks'];
          } else {
            warnings.push(
              'Feature "externalLinks" must be "allow", "prompt" or "deny", so it was ignored.',
            );
          }
        } else {
          warnings.push(`Unknown feature "${name}" was ignored.`);
        }
      }
    }
  }

  let notice: string | null = null;
  if (raw.notice !== undefined) {
    if (typeof raw.notice !== 'string') {
      warnings.push('"notice" must be text, so it was ignored.');
    } else {
      notice = sanitizeNotice(raw.notice) || null;
    }
  }

  return {
    usable: true,
    state: {
      active: true,
      file,
      notice,
      features,
      lockedKeys,
      values: values as Partial<SettingValues>,
      warnings,
    },
  };
}

export interface PolicyServiceOptions {
  file: string;
  logger: Logger;
  /** Watch the file for changes. Default true. */
  watch?: boolean;
  debounceMs?: number;
}

export class PolicyService implements PolicyHost {
  private current: PolicyState = freezeDeep(inactivePolicy());
  private lastGood: PolicyState | null = null;
  private signature = '';
  private readonly emitter = new Emitter<PolicyState>();
  private watcher: FileWatcher | null = null;
  private lastLogged = '';

  constructor(private readonly options: PolicyServiceOptions) {
    this.load();
    this.signature = JSON.stringify(this.current);
    this.logWarnings();
    if (options.watch !== false) {
      this.watcher = watchFile(options.file, () => this.reload(), {
        debounceMs: options.debounceMs,
        logger: options.logger,
      });
    }
  }

  get state(): PolicyState {
    return this.current;
  }

  get file(): string {
    return this.options.file;
  }

  onDidChange(cb: (state: PolicyState) => void): Unsubscribe {
    return this.emitter.on(cb);
  }

  /** Re-read the file now. Returns whether the effective policy changed. */
  reload(): boolean {
    this.load();
    this.logWarnings();
    const signature = JSON.stringify(this.current);
    if (signature === this.signature) return false;
    this.signature = signature;
    this.emitter.emit(this.current);
    return true;
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = null;
  }

  private load(): void {
    const { file } = this.options;
    const read = readConfigText(file);
    if (read.kind === 'missing') {
      this.lastGood = null;
      this.current = freezeDeep(inactivePolicy());
      return;
    }
    if (read.kind === 'error') {
      this.current = freezeDeep(this.fallback(read.message));
      return;
    }
    const parsed = parsePolicy(read.text, file);
    if (!parsed.usable) {
      this.current = freezeDeep(this.fallback(parsed.reason ?? 'Unknown error.'));
      return;
    }
    this.lastGood = freezeDeep(parsed.state);
    this.current = this.lastGood;
  }

  private fallback(reason: string): PolicyState {
    const { file } = this.options;
    if (this.lastGood) {
      return {
        ...this.lastGood,
        warnings: [
          unusableWarning(file, reason, 'The last valid policy stays in effect.'),
          ...this.lastGood.warnings,
        ],
      };
    }
    return restrictivePolicy(file, reason);
  }

  private logWarnings(): void {
    const text = this.current.warnings.join('\n');
    if (text === this.lastLogged) return;
    this.lastLogged = text;
    for (const warning of this.current.warnings) this.options.logger.warn(`Policy: ${warning}`);
  }
}
