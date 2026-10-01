import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { initialGroups, type GroupsState } from './groups-model';

/** The editor area's tabs and groups. Updated through the pure functions in `groups-model.ts`. */
export const groupsStore = createStore<GroupsState>(() => initialGroups());

export function useGroups<T>(selector: (state: GroupsState) => T): T {
  return useStore(groupsStore, selector);
}

/** Apply a pure transition to the store. */
export function updateGroups(change: (state: GroupsState) => GroupsState): void {
  const current = groupsStore.getState();
  const next = change(current);
  if (next !== current) groupsStore.setState(next, true);
}
