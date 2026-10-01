/**
 * The tab and group model of the editor area as plain data and pure functions. The UI renders it,
 * the editor service drives it, and nothing here knows about Monaco, documents or the DOM, so every
 * rule (preview tabs, pinning, most-recently-used order, splitting) is unit tested in Node.
 */
import type { CustomEditorInput, DiffInput } from '../contracts/editor';

export interface FileTabInput {
  kind: 'file';
  /** Document key (`pathKey(path)` or `untitled:N`). */
  key: string;
}

export interface DiffTabInput {
  kind: 'diff';
  id: string;
  diff: DiffInput;
}

export interface CustomTabInput {
  kind: 'custom';
  key: string;
  input: CustomEditorInput;
}

export type TabInput = FileTabInput | DiffTabInput | CustomTabInput;

export interface Tab {
  id: string;
  input: TabInput;
  /** Shown in italics and replaced by the next preview, until the person edits or keeps it open. */
  preview: boolean;
  pinned: boolean;
}

export interface Group {
  id: number;
  tabs: Tab[];
  activeTabId: string | null;
  /** Tab ids, most recently used first. */
  mru: string[];
}

export interface GroupsState {
  groups: Group[];
  activeGroupId: number;
  nextGroupId: number;
}

/** The editor area shows at most this many groups side by side. */
export const MAX_GROUPS = 2;

export function tabIdOf(input: TabInput): string {
  switch (input.kind) {
    case 'file':
      return `file:${input.key}`;
    case 'diff':
      return `diff:${input.id}`;
    case 'custom':
      return `custom:${input.key}`;
  }
}

export function initialGroups(): GroupsState {
  return {
    groups: [{ id: 1, tabs: [], activeTabId: null, mru: [] }],
    activeGroupId: 1,
    nextGroupId: 2,
  };
}

export function groupById(state: GroupsState, groupId: number): Group | undefined {
  return state.groups.find((g) => g.id === groupId);
}

export function activeGroup(state: GroupsState): Group {
  return groupById(state, state.activeGroupId) ?? (state.groups[0] as Group);
}

export function activeTab(group: Group): Tab | undefined {
  return group.tabs.find((t) => t.id === group.activeTabId);
}

/** Locate a tab in any group. */
export function findTab(state: GroupsState, tabId: string): { group: Group; tab: Tab } | undefined {
  for (const group of state.groups) {
    const tab = group.tabs.find((t) => t.id === tabId);
    if (tab) return { group, tab };
  }
  return undefined;
}

function replaceGroup(state: GroupsState, group: Group): GroupsState {
  return { ...state, groups: state.groups.map((g) => (g.id === group.id ? group : g)) };
}

function touch(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter((x) => x !== id)];
}

export interface OpenOptions {
  /** Target group; defaults to the active one. */
  groupId?: number;
  preview?: boolean;
  /** Make the tab (and its group) active. Default true. */
  activate?: boolean;
}

/** Open a tab in a group, or activate it when the group already has it. */
export function openTab(
  state: GroupsState,
  input: TabInput,
  options: OpenOptions = {},
): GroupsState {
  const group = groupById(state, options.groupId ?? state.activeGroupId) ?? activeGroup(state);
  const id = tabIdOf(input);
  const activate = options.activate !== false;
  const existing = group.tabs.find((t) => t.id === id);

  let tabs = group.tabs;
  if (existing) {
    // Opening a file for real (not as a preview) keeps a preview tab open.
    if (existing.preview && options.preview !== true) {
      tabs = tabs.map((t) => (t.id === id ? { ...t, preview: false } : t));
    }
  } else {
    const preview = options.preview === true;
    if (preview) tabs = tabs.filter((t) => !t.preview); // a new preview replaces the old one
    const fresh: Tab = { id, input, preview, pinned: false };
    const anchor = tabs.findIndex((t) => t.id === group.activeTabId);
    const at = anchor === -1 ? tabs.length : anchor + 1;
    tabs = [...tabs.slice(0, at), fresh, ...tabs.slice(at)];
  }

  const next: Group = {
    ...group,
    tabs,
    activeTabId: activate ? id : (group.activeTabId ?? id),
    mru: activate ? touch(group.mru, id) : group.mru.includes(id) ? group.mru : [...group.mru, id],
  };
  const result = replaceGroup(state, next);
  return activate ? { ...result, activeGroupId: group.id } : result;
}

export function activateTab(state: GroupsState, groupId: number, tabId: string): GroupsState {
  const group = groupById(state, groupId);
  if (!group || !group.tabs.some((t) => t.id === tabId)) return state;
  return {
    ...replaceGroup(state, { ...group, activeTabId: tabId, mru: touch(group.mru, tabId) }),
    activeGroupId: groupId,
  };
}

export function setActiveGroup(state: GroupsState, groupId: number): GroupsState {
  return groupById(state, groupId) && state.activeGroupId !== groupId
    ? { ...state, activeGroupId: groupId }
    : state;
}

/** Remove tabs from a group, choosing the next active tab and dropping an emptied extra group. */
function removeTabs(
  state: GroupsState,
  groupId: number,
  removeIds: ReadonlySet<string>,
): GroupsState {
  const group = groupById(state, groupId);
  if (!group || removeIds.size === 0) return state;
  const tabs = group.tabs.filter((t) => !removeIds.has(t.id));
  if (tabs.length === group.tabs.length) return state;
  const mru = group.mru.filter((id) => !removeIds.has(id));
  let activeTabId = group.activeTabId;
  if (activeTabId !== null && removeIds.has(activeTabId)) {
    const closedIndex = group.tabs.findIndex((t) => t.id === activeTabId);
    activeTabId =
      mru.find((id) => tabs.some((t) => t.id === id)) ??
      tabs[Math.min(closedIndex, tabs.length - 1)]?.id ??
      null;
  }
  let next = replaceGroup(state, { ...group, tabs, activeTabId, mru });
  if (tabs.length === 0 && next.groups.length > 1) {
    const groups = next.groups.filter((g) => g.id !== groupId);
    const keep = groups.find((g) => g.id === next.activeGroupId) ?? groups[0];
    next = { ...next, groups, activeGroupId: keep ? keep.id : next.activeGroupId };
  }
  return next;
}

export function closeTab(state: GroupsState, groupId: number, tabId: string): GroupsState {
  return removeTabs(state, groupId, new Set([tabId]));
}

export function closeTabs(
  state: GroupsState,
  groupId: number,
  predicate: (tab: Tab, index: number) => boolean,
): GroupsState {
  const group = groupById(state, groupId);
  if (!group) return state;
  return removeTabs(
    state,
    groupId,
    new Set(group.tabs.filter((t, i) => !t.pinned && predicate(t, i)).map((t) => t.id)),
  );
}

export function closeOthers(state: GroupsState, groupId: number, keepId: string): GroupsState {
  return closeTabs(state, groupId, (t) => t.id !== keepId);
}

export function closeToRight(state: GroupsState, groupId: number, tabId: string): GroupsState {
  const group = groupById(state, groupId);
  const anchor = group?.tabs.findIndex((t) => t.id === tabId) ?? -1;
  if (anchor === -1) return state;
  return closeTabs(state, groupId, (_t, i) => i > anchor);
}

export function setPinned(state: GroupsState, groupId: number, tabId: string, pinned: boolean) {
  const group = groupById(state, groupId);
  if (!group) return state;
  const tabs = group.tabs.map((t) =>
    t.id === tabId ? { ...t, pinned, preview: pinned ? false : t.preview } : t,
  );
  // Pinned tabs sit at the start of the strip, in the order they were pinned.
  const pinnedTabs = tabs.filter((t) => t.pinned);
  const rest = tabs.filter((t) => !t.pinned);
  return replaceGroup(state, { ...group, tabs: [...pinnedTabs, ...rest] });
}

/** An edit or a double click turns a preview tab into a normal one. */
export function keepOpen(state: GroupsState, tabId: string): GroupsState {
  const found = findTab(state, tabId);
  if (!found || !found.tab.preview) return state;
  return replaceGroup(state, {
    ...found.group,
    tabs: found.group.tabs.map((t) => (t.id === tabId ? { ...t, preview: false } : t)),
  });
}

/** Move a tab to a position in a group (possibly another one). */
export function moveTab(
  state: GroupsState,
  fromGroupId: number,
  tabId: string,
  toGroupId: number,
  index: number,
): GroupsState {
  const from = groupById(state, fromGroupId);
  const to = groupById(state, toGroupId);
  const tab = from?.tabs.find((t) => t.id === tabId);
  if (!from || !to || !tab) return state;

  if (fromGroupId === toGroupId) {
    const without = from.tabs.filter((t) => t.id !== tabId);
    const at = Math.max(0, Math.min(index, without.length));
    return replaceGroup(state, {
      ...from,
      tabs: [...without.slice(0, at), tab, ...without.slice(at)],
    });
  }

  const duplicate = to.tabs.find((t) => t.id === tabId);
  let next = state;
  if (!duplicate) {
    const at = Math.max(0, Math.min(index, to.tabs.length));
    next = replaceGroup(next, {
      ...to,
      tabs: [...to.tabs.slice(0, at), { ...tab, preview: false }, ...to.tabs.slice(at)],
    });
  }
  const target = groupById(next, toGroupId) as Group;
  next = replaceGroup(next, { ...target, activeTabId: tabId, mru: touch(target.mru, tabId) });
  next = { ...next, activeGroupId: toGroupId };
  return closeTab(next, fromGroupId, tabId);
}

/** Show the active tab of the active group in a second group on the right. */
export function splitRight(state: GroupsState, tabId?: string): GroupsState {
  const source = activeGroup(state);
  const tab = source.tabs.find((t) => t.id === (tabId ?? source.activeTabId));
  if (!tab) return state;
  if (state.groups.length < MAX_GROUPS) {
    const group: Group = { id: state.nextGroupId, tabs: [], activeTabId: null, mru: [] };
    const withGroup: GroupsState = {
      ...state,
      groups: [...state.groups, group],
      nextGroupId: state.nextGroupId + 1,
    };
    return openTab(withGroup, tab.input, { groupId: group.id });
  }
  const other = state.groups.find((g) => g.id !== source.id) as Group;
  return openTab(state, tab.input, { groupId: other.id });
}

/** Merge a group's tabs into the other group and drop it. */
export function closeGroup(state: GroupsState, groupId: number): GroupsState {
  if (state.groups.length < 2) return state;
  const group = groupById(state, groupId);
  const other = state.groups.find((g) => g.id !== groupId);
  if (!group || !other) return state;
  let tabs = other.tabs;
  for (const tab of group.tabs) if (!tabs.some((t) => t.id === tab.id)) tabs = [...tabs, tab];
  const merged: Group = {
    ...other,
    tabs,
    activeTabId: other.activeTabId ?? group.activeTabId,
    mru: [...other.mru, ...group.mru.filter((id) => !other.mru.includes(id))],
  };
  return { ...state, groups: [merged], activeGroupId: merged.id };
}

/** A document key changed (rename, Save As): file tabs follow it. */
export function renameDocument(state: GroupsState, fromKey: string, toKey: string): GroupsState {
  const fromId = tabIdOf({ kind: 'file', key: fromKey });
  const toId = tabIdOf({ kind: 'file', key: toKey });
  if (fromId === toId) return state;
  const groups = state.groups.map((group) => {
    if (!group.tabs.some((t) => t.id === fromId)) return group;
    const hasTarget = group.tabs.some((t) => t.id === toId);
    const tabs = hasTarget
      ? group.tabs.filter((t) => t.id !== fromId)
      : group.tabs.map((t) =>
          t.id === fromId ? { ...t, id: toId, input: { kind: 'file', key: toKey } as TabInput } : t,
        );
    const swap = (id: string | null) => (id === fromId ? toId : id);
    return {
      ...group,
      tabs,
      activeTabId: swap(group.activeTabId),
      mru: [...new Set(group.mru.map((id) => (id === fromId ? toId : id)))],
    };
  });
  return { ...state, groups };
}

/** Keys of every document that has a tab in some group. */
export function openDocumentKeys(state: GroupsState): Set<string> {
  const keys = new Set<string>();
  for (const group of state.groups) {
    for (const tab of group.tabs) if (tab.input.kind === 'file') keys.add(tab.input.key);
  }
  return keys;
}

/** Tabs in the order Ctrl+Tab visits them: most recently used first. */
export function mruTabs(group: Group): Tab[] {
  const byId = new Map(group.tabs.map((t) => [t.id, t]));
  const ordered: Tab[] = [];
  for (const id of group.mru) {
    const tab = byId.get(id);
    if (tab) ordered.push(tab);
  }
  for (const tab of group.tabs) if (!ordered.includes(tab)) ordered.push(tab);
  return ordered;
}

/** The tab to the left or right of the active one, wrapping around. */
export function neighbourTab(group: Group, step: 1 | -1): Tab | undefined {
  if (group.tabs.length === 0) return undefined;
  const index = group.tabs.findIndex((t) => t.id === group.activeTabId);
  const next = (index + step + group.tabs.length) % group.tabs.length;
  return group.tabs[next];
}
