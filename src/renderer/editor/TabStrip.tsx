import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { basename, dirname, relativeTo } from '@shared/paths';
import type { MenuItem } from '../contracts/layout';
import { ipc, platform } from '../services/ipc';
import { service } from '../services/registry';
import { useWorkspace } from '../state/workspace-store';
import { Icon } from '../ui/Icon';
import { fileIconName } from '../ui/file-icon';
import { IconButton } from '../ui/IconButton';
import { Tooltip } from '../ui/Tooltip';
import { copyText } from '../ui/clipboard';
import { cx } from '../ui/cx';
import { useRovingTabindex } from '../ui/roving';
import { useDocuments } from './documents-store';
import { moveTab, type Group, type Tab } from './groups-model';
import { updateGroups } from './groups-store';
import { editorRuntime } from './runtime';

const DRAG_TYPE = 'application/x-inc-tab';

interface TabView {
  tab: Tab;
  label: string;
  description?: string;
  icon: string;
  dirty: boolean;
  fullPath?: string;
}

/** Build what each tab shows: a name, a dimmed folder when names collide, an icon, a dirty flag. */
function useTabViews(group: Group): TabView[] {
  const docs = useDocuments((s) => s.docs);
  return useMemo(() => {
    const views: TabView[] = group.tabs.map((tab) => {
      const input = tab.input;
      if (input.kind === 'file') {
        const info = docs[input.key];
        const name = info?.name ?? 'Missing file';
        return {
          tab,
          label: name,
          icon: fileIconName(name),
          dirty: info?.dirty ?? false,
          fullPath: info?.path ?? undefined,
        };
      }
      if (input.kind === 'diff') {
        return { tab, label: input.diff.title, icon: 'git-compare', dirty: false };
      }
      return { tab, label: input.input.title, icon: input.input.icon ?? 'file', dirty: false };
    });
    const counts = new Map<string, number>();
    for (const v of views) counts.set(v.label, (counts.get(v.label) ?? 0) + 1);
    for (const v of views) {
      if ((counts.get(v.label) ?? 0) > 1 && v.fullPath)
        v.description = basename(dirname(v.fullPath));
    }
    return views;
  }, [group.tabs, docs]);
}

export function TabStrip({ group, groupActive }: { group: Group; groupActive: boolean }) {
  const views = useTabViews(group);
  const workspace = useWorkspace();
  const roving = useRovingTabindex<HTMLDivElement>({
    orientation: 'horizontal',
    selector: '[role="tab"]',
  });
  const { ref, onKeyDown, onFocus } = roving;
  const scroller = useRef<HTMLDivElement | null>(null);
  const [drop, setDrop] = useState<{ index: number } | null>(null);
  const runtime = () => editorRuntime().service;

  // Keep the active tab visible.
  useEffect(() => {
    scroller.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [group.activeTabId, group.tabs.length]);

  const showTabMenu = (event: MouseEvent, view: TabView) => {
    event.preventDefault();
    const { tab } = view;
    const isFile = tab.input.kind === 'file' && view.fullPath;
    const path = view.fullPath;
    const items: MenuItem[] = [
      { id: 'close', label: 'Close', run: () => void runtime().closeTab(group.id, tab.id) },
      {
        id: 'others',
        label: 'Close others',
        run: () => void runtime().closeOthers(group.id, tab.id),
        disabled: group.tabs.length < 2,
      },
      {
        id: 'right',
        label: 'Close to the right',
        run: () => void runtime().closeToRight(group.id, tab.id),
      },
      { id: 'saved', label: 'Close saved', run: () => void runtime().closeSaved(group.id) },
    ];
    if (isFile && path) {
      items.push(
        { id: 'copy', label: 'Copy path', separatorBefore: true, run: () => void copyText(path) },
        {
          id: 'copyRel',
          label: 'Copy relative path',
          disabled: !workspace,
          run: () => {
            const rel = workspace ? relativeTo(workspace.root, path, platform as never) : null;
            void copyText(rel ?? path);
          },
        },
        {
          id: 'reveal',
          label: 'Reveal in explorer',
          run: () => void service('commands').execute('explorer.reveal', { path }),
        },
        {
          id: 'os',
          label: 'Reveal in file manager',
          run: () => void ipc.invoke('fs:reveal', path),
        },
      );
    }
    items.push(
      {
        id: 'keep',
        label: 'Keep open',
        separatorBefore: true,
        disabled: !tab.preview,
        run: () => runtime().keepOpen(tab.input.kind === 'file' ? tab.input.key : ''),
      },
      {
        id: 'pin',
        label: tab.pinned ? 'Unpin' : 'Pin',
        run: () => runtime().pin(group.id, tab.id, !tab.pinned),
      },
      { id: 'split', label: 'Split right', run: () => runtime().split(tab.id) },
    );
    void service('menus').show(items, { x: event.clientX, y: event.clientY });
  };

  const showAllTabs = (event: MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = views.map((v) => ({
      id: v.tab.id,
      label: v.description ? `${v.label}  ${v.description}` : v.label,
      checked: v.tab.id === group.activeTabId,
      run: () => runtime().activate(group.id, v.tab.id),
    }));
    if (items.length > 0) void service('menus').show(items, { x: rect.left, y: rect.bottom });
  };

  const onDragOver = (event: DragEvent<HTMLElement>, index: number) => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    setDrop({ index: event.clientX < rect.left + rect.width / 2 ? index : index + 1 });
  };

  const onDrop = (event: DragEvent<HTMLElement>, fallbackIndex: number) => {
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    event.preventDefault();
    const index = drop?.index ?? fallbackIndex;
    setDrop(null);
    try {
      const data = JSON.parse(raw) as { groupId: number; tabId: string };
      updateGroups((state) => moveTab(state, data.groupId, data.tabId, group.id, index));
    } catch {
      /* a drag from elsewhere that is not a tab */
    }
  };

  return (
    <div className={cx('eg-tabs', groupActive && 'is-group-active')}>
      <div
        className="eg-tablist"
        role="tablist"
        aria-label="Open editors"
        ref={(node) => {
          scroller.current = node;
          ref(node);
        }}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onDragOver={(e) => onDragOver(e, group.tabs.length - 1)}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
        }}
        onDrop={(e) => onDrop(e, group.tabs.length)}
      >
        {views.map((view, index) => {
          const selected = view.tab.id === group.activeTabId;
          const body = (
            <div
              key={view.tab.id}
              role="tab"
              aria-selected={selected}
              data-tab-id={view.tab.id}
              data-testid={`tab-${view.label}`}
              data-roving=""
              draggable
              className={cx(
                'eg-tab',
                selected && 'is-active',
                view.tab.preview && 'is-preview',
                view.dirty && 'is-dirty',
                view.tab.pinned && 'is-pinned',
                drop?.index === index && 'drop-before',
                drop?.index === index + 1 && index === views.length - 1 && 'drop-after',
              )}
              onClick={() => runtime().activate(group.id, view.tab.id)}
              onDoubleClick={() =>
                view.tab.input.kind === 'file' && runtime().keepOpen(view.tab.input.key)
              }
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void runtime().closeTab(group.id, view.tab.id);
                }
              }}
              onContextMenu={(e) => showTabMenu(e, view)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  runtime().activate(group.id, view.tab.id);
                } else if (e.key === 'Delete') {
                  void runtime().closeTab(group.id, view.tab.id);
                }
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData(
                  DRAG_TYPE,
                  JSON.stringify({ groupId: group.id, tabId: view.tab.id }),
                );
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => setDrop(null)}
            >
              {view.tab.pinned ? (
                <Icon name="pin" size={14} className="eg-tab-icon" />
              ) : (
                <Icon name={view.icon} size={14} className="eg-tab-icon" />
              )}
              <span className="eg-tab-label">{view.label}</span>
              {view.description && <span className="eg-tab-dir">{view.description}</span>}
              <button
                type="button"
                className="eg-tab-close"
                tabIndex={-1}
                aria-label={`Close ${view.label}${view.dirty ? ' (unsaved changes)' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void runtime().closeTab(group.id, view.tab.id);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <span className="eg-tab-dot" aria-hidden="true" />
                <Icon name="close" size={14} className="eg-tab-x" />
              </button>
            </div>
          );
          return view.fullPath ? (
            <Tooltip key={view.tab.id} content={view.fullPath} placement="bottom" delay={800}>
              {body}
            </Tooltip>
          ) : (
            body
          );
        })}
      </div>
      <div className="eg-tabs-actions">
        <IconButton
          icon="list"
          label="Show opened editors"
          onClick={showAllTabs}
          disabled={views.length === 0}
        />
        <IconButton
          icon="split"
          label="Split editor right"
          onClick={() => runtime().split()}
          disabled={views.length === 0}
        />
      </div>
    </div>
  );
}
