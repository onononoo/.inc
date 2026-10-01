import { describe, expect, it } from 'vitest';
import { EMPTY_POLICY, type PolicyState } from '@shared/policy';
import {
  isTrustEnabled,
  TRUST_SETTING,
  type TrustModeSources,
} from '../../../src/main/workspace/trust-mode';

function sources(options: {
  setting?: () => boolean;
  policy?: Partial<PolicyState>;
}): TrustModeSources {
  const state: PolicyState = { ...EMPTY_POLICY, ...options.policy };
  return {
    policy: { state, onDidChange: () => () => undefined },
    settings: {
      get: (() => (options.setting ? options.setting() : true)) as never,
      snapshot: () => null,
      onDidChange: () => () => undefined,
    },
  };
}

describe('isTrustEnabled', () => {
  it('is on by default', () => {
    expect(isTrustEnabled(sources({}))).toBe(true);
  });

  it('follows the user setting', () => {
    expect(isTrustEnabled(sources({ setting: () => false }))).toBe(false);
    expect(isTrustEnabled(sources({ setting: () => true }))).toBe(true);
  });

  it('lets a locked policy value switch trust off over a user value of true', () => {
    const policy = {
      active: true,
      lockedKeys: [TRUST_SETTING],
      values: { [TRUST_SETTING]: false },
    };
    expect(isTrustEnabled(sources({ setting: () => true, policy }))).toBe(false);
  });

  it('lets a locked policy value keep trust on over a user value of false', () => {
    const policy = { active: true, lockedKeys: [TRUST_SETTING], values: { [TRUST_SETTING]: true } };
    expect(isTrustEnabled(sources({ setting: () => false, policy }))).toBe(true);
  });

  it('ignores a policy value that is not locked, and a locked key without a boolean value', () => {
    const unlocked = { values: { [TRUST_SETTING]: false } };
    expect(isTrustEnabled(sources({ setting: () => true, policy: unlocked }))).toBe(true);
    const malformed = { lockedKeys: [TRUST_SETTING], values: {} };
    expect(isTrustEnabled(sources({ setting: () => false, policy: malformed }))).toBe(false);
  });

  it('reads the sources at call time, so later changes apply', () => {
    let value = true;
    const live = sources({ setting: () => value });
    expect(isTrustEnabled(live)).toBe(true);
    value = false;
    expect(isTrustEnabled(live)).toBe(false);
  });
});
