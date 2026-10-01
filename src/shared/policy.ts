/**
 * Enterprise policy.
 *
 * IT administrators deploy a single JSON file (through MDM, Group Policy, configuration
 * management or an image) to a machine-wide, admin-writable location. Everything in it is
 * enforced: policy settings override user and workspace settings and are shown as locked in the
 * settings editor, and `features` switch whole capabilities off.
 *
 * Locations (overridable with the `INC_POLICY_FILE` environment variable):
 *   Windows  %ProgramData%\.inc\policy.json
 *   macOS    /Library/Application Support/.inc/policy.json
 *   Linux    /etc/inc/policy.json
 */
import type { SettingKey, SettingValues } from './settings';

export interface PolicyFeatures {
  /** false disables the integrated terminal. */
  terminal: boolean;
  /** false disables running tasks. */
  tasks: boolean;
  /** false blocks git fetch, pull and push (local Git keeps working). */
  gitRemoteOperations: boolean;
  /** How links that open in the system browser are handled. */
  externalLinks: 'allow' | 'prompt' | 'deny';
}

export const DEFAULT_POLICY_FEATURES: PolicyFeatures = {
  terminal: true,
  tasks: true,
  gitRemoteOperations: true,
  externalLinks: 'prompt',
};

/** The on-disk policy document. Unknown keys are reported as warnings, never fatal. */
export interface PolicyFile {
  version: 1;
  /** Enforced setting values. Any key from the settings schema may be used. */
  settings?: Partial<SettingValues>;
  features?: Partial<PolicyFeatures>;
  /** Shown in Help > About and in the settings editor, e.g. "Managed by Acme IT. help@acme.example". */
  notice?: string;
}

/** What the rest of the app sees. */
export interface PolicyState {
  /** True when a policy file was found and parsed. */
  active: boolean;
  /** Absolute path of the policy file that was read, if any. */
  file: string | null;
  notice: string | null;
  features: PolicyFeatures;
  /** Setting keys the policy enforces. */
  lockedKeys: SettingKey[];
  /** Enforced values for the locked keys. */
  values: Partial<SettingValues>;
  /** Problems found while reading the file (invalid values are ignored, not applied). */
  warnings: string[];
}

export const EMPTY_POLICY: PolicyState = {
  active: false,
  file: null,
  notice: null,
  features: { ...DEFAULT_POLICY_FEATURES },
  lockedKeys: [],
  values: {},
  warnings: [],
};
