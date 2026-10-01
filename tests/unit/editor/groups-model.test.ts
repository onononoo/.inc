import { describe, expect, it } from 'vitest';
import {
  activateTab,
  activeGroup,
  closeGroup,
  closeOthers,
  closeTab,
  closeToRight,
  findTab,
  initialGroups,
  keepOpen,
  moveTab,
  mruTabs,
  neighbourTab,
  openDocumentKeys,
  openTab,
  renameDocument,
  setPinned,
  splitRight,
  tabIdOf,
  type GroupsState,
  type TabInput,
} from '../../../src/renderer/editor/groups-model';

const file = (key: string): TabInput => ({ kind: 'file', key });
const ids = (state: GroupsState, group = 0) => state.groups[group]?.tabs.map((t) => t.id);

function open(keys: string[]): GroupsState {
  let state = initialGroups();
  for (const key of keys) state = openTab(state, file(key));
  return state;
}

describe('opening tabs', () => {
  it('opens a tab after the active one and activates it', () => {
    let state = open(['a', 'b', 'c']);
    state = activateTab(state, 1, 'file:a');
    state = openTab(state, file('d'));
    expect(ids(state)).toEqual(['file:a', 'file:d', 'file:b', 'file:c']);
    expect(activeGroup(state).activeTabId).toBe('file:d');
  });

  it('activates an existing tab instead of duplicating it', () => {
    const state = openTab(open(['a', 'b']), file('a'));
    expect(ids(state)).toEqual(['file:a', 'file:b']);
    expect(activeGroup(state).activeTabId).toBe('file:a');
  });

  it('replaces the previous preview tab with the next one', () => {
    let state = openTab(initialGroups(), file('a'), { preview: true });
    state = openTab(state, file('b'), { preview: true });
    expect(ids(state)).toEqual(['file:b']);
    expect(findTab(state, 'file:b')?.tab.preview).toBe(true);
  });

  it('opening a preview tab for real keeps it open, and an edit does too', () => {
    let state = openTab(initialGroups(), file('a'), { preview: true });
    state = openTab(state, file('a'));
    expect(findTab(state, 'file:a')?.tab.preview).toBe(false);

    state = openTab(state, file('b'), { preview: true });
    state = keepOpen(state, 'file:b');
    state = openTab(state, file('c'), { preview: true });
    expect(ids(state)).toEqual(['file:a', 'file:b', 'file:c']);
  });

  it('can open without activating', () => {
    let state = open(['a']);
    state = openTab(state, file('b'), { activate: false });
    expect(activeGroup(state).activeTabId).toBe('file:a');
    expect(ids(state)).toContain('file:b');
  });

  it('supports diff and custom tabs with stable ids', () => {
    const diff: TabInput = {
      kind: 'diff',
      id: 'x',
      diff: {
        path: '/a',
        originalLabel: 'HEAD',
        originalText: '',
        modified: { kind: 'file' },
        title: 'a',
      },
    };
    const custom: TabInput = {
      kind: 'custom',
      key: 'settings',
      input: { kind: 'settings', key: 'settings', title: 'Settings' },
    };
    expect(tabIdOf(diff)).toBe('diff:x');
    expect(tabIdOf(custom)).toBe('custom:settings');
    const state = openTab(openTab(initialGroups(), diff), custom);
    expect(ids(state)).toEqual(['diff:x', 'custom:settings']);
  });
});

describe('closing tabs', () => {
  it('activates the most recently used tab that remains', () => {
    let state = open(['a', 'b', 'c']);
    state = activateTab(state, 1, 'file:a');
    state = activateTab(state, 1, 'file:c');
    state = closeTab(state, 1, 'file:c');
    expect(activeGroup(state).activeTabId).toBe('file:a');
  });

  it('falls back to a neighbour and then to nothing', () => {
    let state = open(['a', 'b']);
    state = closeTab(state, 1, 'file:b');
    expect(activeGroup(state).activeTabId).toBe('file:a');
    state = closeTab(state, 1, 'file:a');
    expect(activeGroup(state).activeTabId).toBeNull();
    expect(state.groups).toHaveLength(1);
  });

  it('closes others and to the right but never pinned tabs', () => {
    let state = open(['a', 'b', 'c', 'd']);
    state = setPinned(state, 1, 'file:a', true);
    expect(closeOthers(state, 1, 'file:c').groups[0]?.tabs.map((t) => t.id)).toEqual([
      'file:a',
      'file:c',
    ]);
    expect(closeToRight(state, 1, 'file:b').groups[0]?.tabs.map((t) => t.id)).toEqual([
      'file:a',
      'file:b',
    ]);
  });

  it('pinned tabs move to the front in the order they were pinned', () => {
    let state = open(['a', 'b', 'c']);
    state = setPinned(state, 1, 'file:c', true);
    state = setPinned(state, 1, 'file:b', true);
    expect(ids(state)).toEqual(['file:c', 'file:b', 'file:a']);
    expect(findTab(state, 'file:c')?.tab.pinned).toBe(true);
  });
});

describe('groups', () => {
  it('splits right by copying the active tab into a new group', () => {
    const state = splitRight(open(['a', 'b']));
    expect(state.groups).toHaveLength(2);
    expect(ids(state, 1)).toEqual(['file:b']);
    expect(state.activeGroupId).toBe(state.groups[1]?.id);
  });

  it('splitting again shows the tab in the other group instead of adding a third', () => {
    let state = splitRight(open(['a', 'b']));
    state = activateTab(state, 1, 'file:a');
    state = splitRight(state);
    expect(state.groups).toHaveLength(2);
    expect(ids(state, 1)).toEqual(['file:b', 'file:a']);
  });

  it('does nothing when there is no tab to split', () => {
    const state = initialGroups();
    expect(splitRight(state)).toBe(state);
  });

  it('closing the last tab of a second group removes that group', () => {
    let state = splitRight(open(['a']));
    expect(state.groups).toHaveLength(2);
    state = closeTab(state, 2, 'file:a');
    expect(state.groups).toHaveLength(1);
    expect(state.activeGroupId).toBe(1);
  });

  it('closeGroup merges its tabs into the other group without duplicates', () => {
    let state = splitRight(open(['a', 'b']));
    state = openTab(state, file('c'), { groupId: 2 });
    state = closeGroup(state, 2);
    expect(state.groups).toHaveLength(1);
    expect(ids(state)).toEqual(['file:a', 'file:b', 'file:c']);
  });

  it('moves tabs within and between groups', () => {
    let state = open(['a', 'b', 'c']);
    state = moveTab(state, 1, 'file:a', 1, 2);
    expect(ids(state)).toEqual(['file:b', 'file:c', 'file:a']);

    state = splitRight(state);
    state = moveTab(state, 1, 'file:b', 2, 0);
    expect(ids(state, 0)).toEqual(['file:c', 'file:a']);
    // The split copied the active tab (c) into the second group; b then moved in front of it.
    expect(ids(state, 1)).toEqual(['file:b', 'file:c']);
    expect(state.activeGroupId).toBe(2);
  });

  it('moving the only tab out of a group removes the group', () => {
    let state = splitRight(open(['a']));
    state = moveTab(state, 2, 'file:a', 1, 0);
    expect(state.groups).toHaveLength(1);
  });
});

describe('renaming, MRU and neighbours', () => {
  it('file tabs follow a renamed document, keeping order and activity', () => {
    let state = open(['a', 'b']);
    state = activateTab(state, 1, 'file:a');
    state = renameDocument(state, 'a', 'z');
    expect(ids(state)).toEqual(['file:z', 'file:b']);
    expect(activeGroup(state).activeTabId).toBe('file:z');
    expect(openDocumentKeys(state)).toEqual(new Set(['z', 'b']));
  });

  it('renaming onto an already open document merges the tabs', () => {
    const state = renameDocument(open(['a', 'b']), 'a', 'b');
    expect(ids(state)).toEqual(['file:b']);
  });

  it('lists tabs by recent use and finds the neighbour with wraparound', () => {
    let state = open(['a', 'b', 'c']);
    state = activateTab(state, 1, 'file:a');
    state = activateTab(state, 1, 'file:b');
    const group = activeGroup(state);
    expect(mruTabs(group).map((t) => t.id)).toEqual(['file:b', 'file:a', 'file:c']);
    expect(neighbourTab(group, 1)?.id).toBe('file:c');
    expect(neighbourTab(activateTab(state, 1, 'file:c').groups[0]!, 1)?.id).toBe('file:a');
    expect(neighbourTab(activateTab(state, 1, 'file:a').groups[0]!, -1)?.id).toBe('file:c');
    expect(neighbourTab(initialGroups().groups[0]!, 1)).toBeUndefined();
  });
});
