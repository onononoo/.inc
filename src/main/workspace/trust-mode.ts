import type { Kernel } from '../kernel';

export const TRUST_SETTING = 'security.workspaceTrust' as const;

/** The parts of the kernel that decide whether workspace trust is on. */
export type TrustModeSources = Pick<Kernel, 'policy' | 'settings'>;

/**
 * Whether workspace trust is on. A policy that locks the setting wins; otherwise the app-wide
 * user value is used (default on). The app-wide value is read on purpose, so a workspace can
 * never switch its own trust off. Call it at the moment of use: both sources can change.
 */
export function isTrustEnabled(sources: TrustModeSources): boolean {
  const { lockedKeys, values } = sources.policy.state;
  const enforced = values[TRUST_SETTING];
  if (lockedKeys.includes(TRUST_SETTING) && typeof enforced === 'boolean') return enforced;
  return sources.settings.get(null, TRUST_SETTING) !== false;
}
