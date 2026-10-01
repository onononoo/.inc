import { create } from 'zustand';
import { EMPTY_POLICY, type PolicyState } from '@shared/policy';
import { ipc } from '../services/ipc';

interface PolicyStoreState {
  policy: PolicyState;
}

export const usePolicyStore = create<PolicyStoreState>(() => ({ policy: EMPTY_POLICY }));

let started = false;

/** Load the enterprise policy state and follow changes. Safe to call more than once. */
export async function initPolicy(): Promise<void> {
  if (started) return;
  started = true;
  ipc.on('policy:changed', (policy) => usePolicyStore.setState({ policy }));
  usePolicyStore.setState({ policy: await ipc.invoke('policy:get').catch(() => EMPTY_POLICY) });
}

export function usePolicy(): PolicyState {
  return usePolicyStore((s) => s.policy);
}

export function getPolicy(): PolicyState {
  return usePolicyStore.getState().policy;
}
