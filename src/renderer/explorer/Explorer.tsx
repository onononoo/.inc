import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { dirname, relativeTo, type Platform } from '@shared/paths';
import type { MenuItem } from '../contracts/layout';
import { platform as hostPlatform } from '../services/ipc';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { decorationFor, folderHasChanges, useGitStore } from '../scm/git-store';
import { useSetting } from '../state/settings-store';
import { useWorkspace } from '../state/workspace-store';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { VirtualList, type VirtualListHandle } from '../ui/VirtualList';
import { copyText } from '../ui/clipboard';
import { cx } from '../ui/cx';
import { fileIconName } from '../ui/file-icon';
import { typeaheadIndex } from '../ui/menu-nav';
import {
  cancelEdit,
  collapseAll,
  commitCreate,
  commitRename,
  copyToClipboard,
  deleteEntries,
  dropOn,
  duplicateEntries,
  expand,
  paste,
  refreshAll,
  retry,
  select,
  setFocused,
  siblingNames,
  startCreate,
  startRename,
  toggle,
  useExplorerStore,
} from './explorer-store';
import { baseNameRange, flatten, indexOfPath, validateName, type TreeRow } from './tree-model';
import './explorer.css';

const platform = hostPlatform as Platform;
const DRAG_TYPE = 'application/x-inc-paths';
const SPRING_LOAD_MS = 700;

/** Inline name field for creating and renaming. Enter accepts, Escape cancels. */
function NameInput({
  initial,
  select: range,
  siblings,
  current,
  allowSeparators,
  onCommit,
  ariaLabel,
}: {
  initial: string;
  select: [number, number];
  siblings: readonly string[];
  current?: string;
  allowSeparators: boolean;
  onCommit: (name: string) => void;
  ariaLabel: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initial);
  const check = useMemo(
    () => validateName(value, { platform, siblings, allowSeparators, current }),
    [value, siblings, allowSeparators, current],
  );
  const showError = value !== initial || value === '';

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(range[0], range[1]);
    // Focus and select once, when the field appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span className="tree-edit">
      <input
        ref={ref}
        className={cx('tree-input', !check.ok && showError && 'is-invalid')}
        aria-label={ariaLabel}
        aria-invalid={!check.ok && showError ? true : undefined}
        value={value}
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            if (check.ok) onCommit(value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
          }
        }}
        onBlur={() => cancelEdit()}
        onClick={(e) => e.stopPropagation()}
      />
      {!check.ok && showError && (
        <span className="tree-edit-error" role="alert">
          {check.message}
        </span>
      )}
    </span>
  );
}

function NoFolder() {
  const commands = service('commands');
  return (
    <div className="explorer-empty">
      <EmptyState
        title="You have not opened a folder"
        description="Open a folder to browse files and use source control."
        action={
          <span className="explorer-empty-actions">
            <Button variant="primary" onClick={() => void commands.execute('file.openFolder')}>
              Open folder
            </Button>
            <Button onClick={() => void commands.execute('file.openRecent')}>Open recent</Button>
          </span>
        }
      />
    </div>
  );
}

/** The file explorer: a virtualised tree of the open folder, with every file operation. */
export function Explorer() {
  const workspace = useWorkspace();
  const state = useExplorerStore();
  const gitVersion = useGitStore((s) => s.version);
  const showDecorations = useSetting('git.decorations');
  const list = useRef<VirtualListHandle>(null);
  const typed = useRef<{ text: string; timer: ReturnType<typeof setTimeout> | null }>({
    text: '',
    timer: null,
  });
  const spring = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const rows = useMemo(
    () => flatten(state, state.edit?.type === 'create' ? state.edit : null),
    // `flatten` depends on the tree slices below; the version covers listings changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.version, state.root, state.edit],
  );
  const rowPaths = useMemo(
    () => rows.map((r) => (r.type === 'node' ? r.path : r.type === 'error' ? r.path : '')),
    [rows],
  );
  const activeIndex = state.focused
    ? indexOfPath(rows, state.focused, platform)
    : rows.length > 0
      ? 0
      : -1;

  useEffect(() => {
    if (!state.focused) return;
    const index = indexOfPath(rows, state.focused, platform);
    if (index >= 0) list.current?.scrollToIndex(index, 'nearest');
  }, [state.focused, rows]);

  // Keep a rename's row visible while it is being edited.
  useEffect(() => {
    if (state.edit?.type === 'rename') {
      const index = indexOfPath(rows, state.edit.path, platform);
      if (index >= 0) list.current?.scrollToIndex(index, 'nearest');
    }
  }, [state.edit, rows]);

  if (!workspace) return <NoFolder />;

  const open = (path: string, options: { preview: boolean; focus: boolean }) =>
    void service('commands').execute('editor.openFile', { path, ...options });

  const activate = (row: Extract<TreeRow, { type: 'node' }>, via: 'click' | 'key' | 'double') => {
    if (row.kind === 'directory') {
      if (via !== 'double') void toggle(row.path);
      return;
    }
    if (via === 'click') open(row.path, { preview: true, focus: false });
    else open(row.path, { preview: false, focus: true });
  };

  const decorate = (row: Extract<TreeRow, { type: 'node' }>) => {
    if (!showDecorations) return null;
    if (row.kind === 'directory') return folderHasChanges(row.path) ? { dot: true as const } : null;
    return decorationFor(row.path);
  };
  void gitVersion;

  const showMenu = (
    event: { clientX: number; clientY: number },
    path: string | null,
    isFolder: boolean,
  ) => {
    const selection = path ? (state.selected.has(path) ? [...state.selected] : [path]) : [];
    if (path && !state.selected.has(path)) select(path, 'single', rowPaths);
    const folderTarget = path ? (isFolder ? path : dirname(path)) : workspace.root;
    const single = selection.length === 1 ? (selection[0] as string) : null;
    const cmd = (id: string) => () => void service('commands').execute(id);
    const items: MenuItem[] = [
      { id: 'newFile', label: 'New file', run: () => void startCreate('file', folderTarget) },
      {
        id: 'newFolder',
        label: 'New folder',
        run: () => void startCreate('directory', folderTarget),
      },
    ];
    if (single && !isFolder) {
      items.push({
        id: 'open',
        label: 'Open',
        separatorBefore: true,
        run: () => open(single, { preview: false, focus: true }),
      });
      items.push({ id: 'side', label: 'Open to the side', run: cmd('explorer.openToSide') });
    }
    if (selection.length > 0) {
      items.push(
        {
          id: 'cut',
          label: 'Cut',
          separatorBefore: true,
          keybinding: service('keybindings').labelFor('explorer.cut'),
          run: () => copyToClipboard(selection, 'cut'),
        },
        {
          id: 'copy',
          label: 'Copy',
          keybinding: service('keybindings').labelFor('explorer.copy'),
          run: () => copyToClipboard(selection, 'copy'),
        },
      );
    }
    items.push({
      id: 'paste',
      label: 'Paste',
      keybinding: service('keybindings').labelFor('explorer.paste'),
      disabled: !state.clipboard,
      separatorBefore: selection.length === 0,
      run: () => void paste(folderTarget),
    });
    if (selection.length > 0) {
      items.push(
        { id: 'duplicate', label: 'Duplicate', run: () => void duplicateEntries(selection) },
        {
          id: 'copyPath',
          label: 'Copy path',
          separatorBefore: true,
          run: () => void copyText(selection.join('\n')),
        },
        {
          id: 'copyRel',
          label: 'Copy relative path',
          run: () =>
            void copyText(
              selection.map((p) => relativeTo(workspace.root, p, platform) ?? p).join('\n'),
            ),
        },
        {
          id: 'reveal',
          label: 'Reveal in file manager',
          run: () => void ipc.invoke('fs:reveal', selection[0] as string),
        },
        {
          id: 'find',
          label: 'Find in folder',
          run: cmd('explorer.findInFolder'),
          disabled: !isFolder,
        },
        {
          id: 'rename',
          label: 'Rename',
          separatorBefore: true,
          keybinding: service('keybindings').labelFor('explorer.rename'),
          disabled: selection.length !== 1,
          run: () => single && startRename(single),
        },
        {
          id: 'delete',
          label: 'Delete',
          danger: true,
          keybinding: service('keybindings').labelFor('explorer.delete'),
          run: () => void deleteEntries(selection),
        },
      );
    }
    void service('menus').show(items, { x: event.clientX, y: event.clientY });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[activeIndex];
    if (!row || row.type === 'create') return;
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      showMenu(
        { clientX: rect.left + 40, clientY: rect.top + 40 },
        row.type === 'node' ? row.path : null,
        row.type === 'node' && row.kind === 'directory',
      );
      return;
    }
    if (row.type !== 'node') return;
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        if (row.kind === 'directory') {
          if (!row.expanded) void expand(row.path);
          else if (rows[activeIndex + 1]?.type === 'node')
            setFocused((rows[activeIndex + 1] as { path: string }).path);
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (row.kind === 'directory' && row.expanded) {
          void toggle(row.path);
        } else {
          const parent = dirname(row.path);
          if (rows.some((r) => r.type === 'node' && r.path === parent)) {
            select(parent, 'single', rowPaths);
          }
        }
        break;
      case 'Enter':
        if (platform === 'darwin') return; // Enter renames on macOS (explorer.rename)
        event.preventDefault();
        activate(row, 'key');
        break;
      case ' ':
        event.preventDefault();
        select(row.path, 'toggle', rowPaths);
        break;
      case 'ArrowDown':
      case 'ArrowUp':
        if (event.shiftKey) {
          event.preventDefault();
          const next = rows[activeIndex + (event.key === 'ArrowDown' ? 1 : -1)];
          if (next?.type === 'node') select(next.path, 'range', rowPaths);
        }
        break;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          // Type-ahead: jump to the next entry whose name starts with what was typed.
          const buffer = typed.current;
          if (buffer.timer) clearTimeout(buffer.timer);
          buffer.text += event.key;
          buffer.timer = setTimeout(() => (buffer.text = ''), 700);
          const index = typeaheadIndex(
            rows.map((r) => ({ label: r.type === 'node' ? r.name : '' })),
            buffer.text,
            activeIndex,
          );
          const target = rows[index];
          if (target?.type === 'node') {
            event.preventDefault();
            select(target.path, 'single', rowPaths);
          }
        }
        break;
    }
  };

  const onRowDragStart = (event: DragEvent, path: string) => {
    const paths = state.selected.has(path) ? [...state.selected] : [path];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    event.dataTransfer.effectAllowed = 'copyMove';
  };

  const sourcesOf = (event: DragEvent): string[] | null => {
    const raw = event.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((p): p is string => typeof p === 'string')
        : null;
    } catch {
      return null;
    }
  };

  const clearSpring = () => {
    if (spring.current) clearTimeout(spring.current.timer);
    spring.current = null;
  };

  const renderNode = (
    row: Extract<TreeRow, { type: 'node' }>,
    rowState: { active: boolean; id: string },
  ) => {
    const selected = state.selected.has(row.path);
    const decoration = decorate(row);
    const renaming = state.edit?.type === 'rename' && state.edit.path === row.path;
    const isDir = row.kind === 'directory';
    const cut = state.clipboard?.mode === 'cut' && state.clipboard.paths.includes(row.path);
    const label =
      decoration && 'tooltip' in decoration ? `${row.name}, ${decoration.tooltip}` : row.name;
    return (
      <div
        id={rowState.id}
        role="treeitem"
        aria-level={row.depth + 1}
        aria-expanded={isDir ? row.expanded : undefined}
        aria-selected={selected}
        aria-label={label}
        data-testid={`tree-${row.name}`}
        data-path={row.path}
        className={cx(
          'row',
          'tree-row',
          selected && 'is-selected',
          rowState.active && 'is-active',
          cut && 'is-cut',
          dropTarget === row.path && 'is-drop-target',
          decoration && 'tone' in decoration && `tone-${decoration.tone}`,
        )}
        style={{ paddingLeft: `calc(var(--space-2) + ${row.depth * 16}px)` }}
        draggable={!renaming}
        onClick={(e: MouseEvent) => {
          if (renaming) return;
          if (e.shiftKey) select(row.path, 'range', rowPaths);
          else if (e.ctrlKey || e.metaKey) select(row.path, 'toggle', rowPaths);
          else {
            select(row.path, 'single', rowPaths);
            activate(row, 'click');
          }
        }}
        onDoubleClick={() => !renaming && activate(row, 'double')}
        onContextMenu={(e) => {
          e.preventDefault();
          showMenu(e, row.path, isDir);
        }}
        onDragStart={(e) => onRowDragStart(e, row.path)}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = e.ctrlKey || e.altKey ? 'copy' : 'move';
          const target = isDir ? row.path : dirname(row.path);
          setDropTarget(target === workspace.root ? null : isDir ? row.path : dirname(row.path));
          if (isDir && !row.expanded && spring.current?.path !== row.path) {
            clearSpring();
            spring.current = {
              path: row.path,
              timer: setTimeout(() => void expand(row.path), SPRING_LOAD_MS),
            };
          }
        }}
        onDragLeave={() => setDropTarget((current) => (current === row.path ? null : current))}
        onDragEnd={() => {
          clearSpring();
          setDropTarget(null);
        }}
        onDrop={(e) => {
          const sources = sourcesOf(e);
          clearSpring();
          setDropTarget(null);
          if (!sources) return;
          e.preventDefault();
          void dropOn(sources, row.path, isDir, e.ctrlKey || e.altKey);
        }}
      >
        <span className="tree-guides" aria-hidden="true" style={{ width: row.depth * 16 }} />
        {isDir ? (
          <Icon
            name={row.loading ? 'loader' : row.expanded ? 'chevron-down' : 'chevron-right'}
            className="tree-chevron"
          />
        ) : (
          <span className="tree-chevron-space" />
        )}
        <Icon
          name={isDir ? (row.expanded ? 'folder-open' : 'folder') : fileIconName(row.name)}
          className="row-icon"
        />
        {renaming ? (
          <NameInput
            initial={row.name}
            select={baseNameRange(row.name, !isDir)}
            siblings={siblingNames(dirname(row.path))}
            current={row.name}
            allowSeparators={false}
            ariaLabel={`Rename ${row.name}`}
            onCommit={(name) => void commitRename(name)}
          />
        ) : (
          <span
            className={cx(
              'row-label',
              decoration && 'tone' in decoration && decoration.letter === 'D' && 'is-deleted',
            )}
          >
            {row.name}
          </span>
        )}
        {decoration && 'letter' in decoration && (
          <span className="tree-git" aria-hidden="true">
            {decoration.letter}
          </span>
        )}
        {decoration && 'dot' in decoration && <span className="tree-git-dot" aria-hidden="true" />}
      </div>
    );
  };

  return (
    <div
      className="explorer"
      onDragOver={(e) => {
        if (e.target === e.currentTarget && e.dataTransfer.types.includes(DRAG_TYPE))
          e.preventDefault();
      }}
      onDrop={(e) => {
        const sources = e.target === e.currentTarget ? sourcesOf(e) : null;
        if (!sources) return;
        e.preventDefault();
        void dropOn(sources, workspace.root, true, e.ctrlKey || e.altKey);
      }}
    >
      <div className="explorer-header">
        <span className="explorer-root" title={workspace.root}>
          {workspace.name}
        </span>
        <div className="explorer-actions">
          <IconButton icon="file-plus" label="New file" onClick={() => void startCreate('file')} />
          <IconButton
            icon="folder-plus"
            label="New folder"
            onClick={() => void startCreate('directory')}
          />
          <IconButton icon="refresh" label="Refresh" onClick={() => void refreshAll()} />
          <IconButton icon="collapse-all" label="Collapse all" onClick={collapseAll} />
        </div>
      </div>
      <VirtualList
        ref={list}
        className="explorer-tree"
        role="tree"
        label="Files"
        count={rows.length}
        rowHeight={24}
        multiselectable
        activeIndex={activeIndex}
        onActiveIndexChange={(index) => {
          const row = rows[index];
          if (row?.type === 'node') select(row.path, 'single', rowPaths);
        }}
        onKeyDown={onKeyDown}
        empty={
          state.loading.has(workspace.root) ? undefined : state.errors[
              workspace.root
            ] ? undefined : (
            <EmptyState
              title="This folder is empty"
              description="Create a file or folder to get started."
            />
          )
        }
        renderRow={(index, rowState) => {
          const row = rows[index];
          if (!row) return null;
          if (row.type === 'node') return renderNode(row, rowState);
          if (row.type === 'create') {
            return (
              <div
                id={rowState.id}
                role="treeitem"
                aria-level={row.depth + 1}
                className="row tree-row is-creating"
                style={{ paddingLeft: `calc(var(--space-2) + ${row.depth * 16}px)` }}
              >
                <span className="tree-chevron-space" />
                <Icon name={row.kind === 'directory' ? 'folder' : 'file'} className="row-icon" />
                <NameInput
                  initial=""
                  select={[0, 0]}
                  siblings={siblingNames(row.parent)}
                  allowSeparators
                  ariaLabel={row.kind === 'directory' ? 'New folder name' : 'New file name'}
                  onCommit={(name) => void commitCreate(name)}
                />
              </div>
            );
          }
          return (
            <div
              id={rowState.id}
              role="treeitem"
              aria-level={row.depth + 1}
              className="row tree-row tree-error"
              style={{ paddingLeft: `calc(var(--space-2) + ${row.depth * 16}px)` }}
            >
              <Icon name="alert-circle" className="tree-error-icon" />
              <span className="row-label">{row.message}</span>
              <Button size="sm" variant="ghost" onClick={() => retry(row.path)}>
                Try again
              </Button>
            </div>
          );
        }}
      />
      {state.loading.has(workspace.root) && rows.length === 0 && (
        <div className="explorer-loading" role="status">
          Reading folder
        </div>
      )}
    </div>
  );
}
