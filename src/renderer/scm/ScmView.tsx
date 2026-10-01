import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { basename, dirname, type Platform } from '@shared/paths';
import type { MenuItem } from '../contracts/layout';
import { ipc, platform as hostPlatform } from '../services/ipc';
import { service } from '../services/registry';
import { useSetting } from '../state/settings-store';
import { useWorkspace } from '../state/workspace-store';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { VirtualList } from '../ui/VirtualList';
import { copyText } from '../ui/clipboard';
import { cx } from '../ui/cx';
import { fileIconName } from '../ui/file-icon';
import {
  checkout,
  commit,
  createBranch,
  discard,
  fetchRemote,
  initRepository,
  openDiff,
  pull,
  push,
  refresh,
  stage,
  stageAll,
  unstage,
  unstageAll,
} from './scm-actions';
import { clearCommit, setAmend, setBusy, setMessage, useCommitStore } from './commit-store';
import { useGitStore } from './git-store';
import {
  buildGroups,
  flattenGroups,
  totalChanges,
  type ScmGroupId,
  type ScmItem,
  type ScmRow,
} from './scm-model';
import './scm.css';

const platform = hostPlatform as Platform;
const MAX_LINES = 6;

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function CommitBox({ stagedCount, disabled }: { stagedCount: number; disabled: boolean }) {
  const { message, amend, busy, focusNonce } = useCommitStore();
  const ref = useRef<HTMLTextAreaElement>(null);
  const lines = Math.min(MAX_LINES, Math.max(1, message.split('\n').length));
  const canCommit = !disabled && !busy && (amend || (stagedCount > 0 && message.trim() !== ''));

  useEffect(() => {
    if (focusNonce > 0) ref.current?.focus();
  }, [focusNonce]);

  const submit = async () => {
    if (!canCommit) return;
    setBusy(true);
    const ok = await commit(message, amend);
    setBusy(false);
    if (ok) clearCommit();
  };

  return (
    <div className="scm-commit">
      <textarea
        ref={ref}
        className="ui-input scm-message"
        aria-label="Commit message"
        placeholder={`Message (${platform === 'darwin' ? 'Cmd' : 'Ctrl'}+Enter to commit)`}
        rows={lines}
        value={message}
        disabled={disabled}
        spellCheck
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="scm-commit-actions">
        <Checkbox checked={amend} disabled={disabled} onChange={setAmend}>
          Amend
        </Checkbox>
        <Button
          variant="primary"
          size="sm"
          busy={busy}
          disabled={!canCommit}
          onClick={() => void submit()}
        >
          {amend ? 'Amend commit' : 'Commit'}
        </Button>
      </div>
    </div>
  );
}

/** The Source Control view: branch, commit box, and the conflicts, staged and unstaged changes. */
export function ScmView() {
  const workspace = useWorkspace();
  const git = useGitStore();
  const enabled = useSetting('git.enabled');
  const [collapsed, setCollapsed] = useState<ReadonlySet<ScmGroupId>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState(-1);
  const trusted = workspace?.trust !== 'untrusted';

  const groups = useMemo(() => buildGroups(git.status?.files ?? []), [git.status]);
  const rows = useMemo(() => flattenGroups(groups, collapsed), [groups, collapsed]);
  const stagedCount = groups.find((g) => g.id === 'staged')?.items.length ?? 0;

  if (!workspace) {
    return (
      <div className="scm-empty">
        <EmptyState
          title="You have not opened a folder"
          description="Open a folder to use source control."
          action={
            <Button
              variant="primary"
              onClick={() => void service('commands').execute('file.openFolder')}
            >
              Open folder
            </Button>
          }
        />
      </div>
    );
  }
  if (!enabled) {
    return (
      <div className="scm-empty">
        <EmptyState
          title="Git is turned off"
          description="Turn on git.enabled in settings to use source control."
          action={
            <Button onClick={() => void service('commands').execute('settings.open')}>
              Open settings
            </Button>
          }
        />
      </div>
    );
  }
  if (git.available === false) {
    return (
      <div className="scm-empty">
        <EmptyState
          title="Git was not found"
          description={
            git.availability?.error ?? 'Install Git, or set its location in the git.path setting.'
          }
          action={
            <Button onClick={() => void service('commands').execute('settings.open')}>
              Open settings
            </Button>
          }
        />
      </div>
    );
  }
  if (git.status === undefined) {
    return (
      <div className="scm-empty" role="status">
        <EmptyState title="Reading repository" />
      </div>
    );
  }
  if (git.status === null) {
    return (
      <div className="scm-empty">
        <EmptyState
          title={git.error ? 'Source control stopped' : 'This folder is not a Git repository'}
          description={
            git.error ??
            (trusted
              ? 'Initialize a repository to track changes.'
              : 'Trust this folder to initialize a repository.')
          }
          action={
            git.error ? (
              <Button onClick={() => void refresh()}>Try again</Button>
            ) : trusted ? (
              <Button variant="primary" onClick={() => void initRepository()}>
                Initialize repository
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void ipc.invoke('workspace:setTrust', true)}>
                Trust folder
              </Button>
            )
          }
        />
      </div>
    );
  }

  const { status } = git;
  const repo = status.repo;
  const branchLabel = repo.detached
    ? `HEAD detached at ${repo.head}`
    : (repo.branch ?? 'No commits yet');
  const itemRows = rows.filter((r): r is Extract<ScmRow, { type: 'item' }> => r.type === 'item');
  const selectedItems = (item: ScmItem) =>
    selected.has(item.key)
      ? itemRows.filter((r) => selected.has(r.item.key)).map((r) => r.item)
      : [item];

  const act = (items: ScmItem[], action: 'stage' | 'unstage' | 'discard') => {
    const paths = [...new Set(items.map((i) => i.file.path))];
    if (action === 'stage') void stage(paths);
    else if (action === 'unstage') void unstage(paths);
    else void discard(paths, items.filter((i) => i.file.workingTree === '?').length);
  };

  const rowMenu = (event: { clientX: number; clientY: number }, item: ScmItem) => {
    const items = selectedItems(item);
    const group = item.group;
    const menu: MenuItem[] = [
      {
        id: 'changes',
        label: 'Open changes',
        disabled: items.length !== 1,
        run: () => void openDiff(item.file.path, group === 'staged'),
      },
      {
        id: 'file',
        label: 'Open file',
        disabled: items.length !== 1 || item.file.workingTree === 'D',
        run: () => void service('commands').execute('editor.openFile', { path: item.file.path }),
      },
    ];
    if (trusted) {
      if (group === 'changes')
        menu.push({
          id: 'stage',
          label: 'Stage changes',
          separatorBefore: true,
          run: () => act(items, 'stage'),
        });
      if (group === 'staged')
        menu.push({
          id: 'unstage',
          label: 'Unstage changes',
          separatorBefore: true,
          run: () => act(items, 'unstage'),
        });
      if (group === 'conflicts')
        menu.push({
          id: 'resolve',
          label: 'Mark as resolved',
          separatorBefore: true,
          run: () => act(items, 'stage'),
        });
      if (group === 'changes')
        menu.push({
          id: 'discard',
          label: 'Discard changes',
          danger: true,
          run: () => act(items, 'discard'),
        });
    }
    menu.push(
      {
        id: 'copy',
        label: 'Copy path',
        separatorBefore: true,
        run: () => void copyText(items.map((i) => i.file.path).join('\n')),
      },
      {
        id: 'reveal',
        label: 'Reveal in explorer',
        run: () => void service('commands').execute('explorer.reveal', { path: item.file.path }),
      },
    );
    void service('menus').show(menu, { x: event.clientX, y: event.clientY });
  };

  const moreMenu = (event: { currentTarget: HTMLElement }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = [
      { id: 'refresh', label: 'Refresh', run: () => void refresh() },
      {
        id: 'fetch',
        label: 'Fetch',
        separatorBefore: true,
        disabled: !trusted,
        run: () => void fetchRemote(),
      },
      { id: 'pull', label: 'Pull', disabled: !trusted, run: () => void pull() },
      { id: 'push', label: 'Push', disabled: !trusted, run: () => void push() },
      {
        id: 'checkout',
        label: 'Checkout to...',
        separatorBefore: true,
        disabled: !trusted,
        run: () => void checkout(),
      },
      {
        id: 'branch',
        label: 'Create branch...',
        disabled: !trusted,
        run: () => void createBranch(),
      },
      {
        id: 'stageAll',
        label: 'Stage all changes',
        separatorBefore: true,
        disabled: !trusted,
        run: () => void stageAll(),
      },
      {
        id: 'unstageAll',
        label: 'Unstage all changes',
        disabled: !trusted,
        run: () => void unstageAll(),
      },
    ];
    void service('menus').show(items, { x: rect.left, y: rect.bottom });
  };

  const toggleGroup = (id: ScmGroupId) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onSelect = (
    item: ScmItem,
    index: number,
    e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => {
    setActive(index);
    if (e.shiftKey && active >= 0) {
      const [a, b] = active < index ? [active, index] : [index, active];
      setSelected(
        new Set(
          rows
            .slice(a, b + 1)
            .filter((r): r is Extract<ScmRow, { type: 'item' }> => r.type === 'item')
            .map((r) => r.item.key),
        ),
      );
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((current) => {
        const next = new Set(current);
        if (next.has(item.key)) next.delete(item.key);
        else next.add(item.key);
        return next;
      });
    } else {
      setSelected(new Set([item.key]));
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[active];
    if (!row) return;
    if (row.type === 'group') {
      if (e.key === 'ArrowRight' && row.collapsed) toggleGroup(row.group.id);
      else if (e.key === 'ArrowLeft' && !row.collapsed) toggleGroup(row.group.id);
      else return;
      e.preventDefault();
      return;
    }
    if (e.key === ' ' && trusted) {
      e.preventDefault();
      act(selectedItems(row.item), row.item.group === 'staged' ? 'unstage' : 'stage');
    }
  };

  const total = totalChanges(groups);

  return (
    <div className="scm" data-testid="scm-view">
      <div className="scm-header">
        <span className="scm-branch" title={branchLabel}>
          <Icon name="git-branch" />
          <span className="scm-branch-name">{branchLabel}</span>
          {(repo.ahead > 0 || repo.behind > 0) && (
            <span className="scm-sync" aria-label={`${repo.ahead} to push, ${repo.behind} to pull`}>
              {repo.behind > 0 && `↓${repo.behind}`}
              {repo.ahead > 0 && `↑${repo.ahead}`}
            </span>
          )}
        </span>
        <span className="scm-header-actions">
          <IconButton icon="refresh" label="Refresh" onClick={() => void refresh()} />
          <IconButton icon="more" label="More actions" onClick={moreMenu} />
        </span>
      </div>

      {!trusted && (
        <div className="scm-note">
          <Icon name="shield-alert" className="scm-note-icon" />
          <span>Restricted Mode. Git changes are turned off until you trust this folder.</span>
          <Button
            size="sm"
            variant="primary"
            onClick={() => void ipc.invoke('workspace:setTrust', true)}
          >
            Trust folder
          </Button>
        </div>
      )}

      <CommitBox stagedCount={stagedCount} disabled={!trusted} />

      {status.truncated && (
        <div className="scm-note" role="status">
          Showing {status.files.length.toLocaleString('en-US')} of{' '}
          {status.totalChanged.toLocaleString('en-US')} changes.
        </div>
      )}

      <VirtualList
        className="scm-list"
        role="tree"
        label="Changes"
        count={rows.length}
        rowHeight={24}
        multiselectable
        activeIndex={active}
        onActiveIndexChange={setActive}
        onKeyDown={onKeyDown}
        onActivate={(index) => {
          const row = rows[index];
          if (!row) return;
          if (row.type === 'group') toggleGroup(row.group.id);
          else void openDiff(row.item.file.path, row.item.group === 'staged');
        }}
        empty={
          total === 0 ? (
            <EmptyState title="No changes" description="Modified files appear here." />
          ) : undefined
        }
        renderRow={(index, rowState) => {
          const row = rows[index];
          if (!row) return null;
          if (row.type === 'group') {
            const { group } = row;
            return (
              <div
                id={rowState.id}
                role="treeitem"
                aria-level={1}
                aria-expanded={!row.collapsed}
                className={cx('row', 'scm-group', rowState.active && 'is-active')}
                onClick={() => {
                  setActive(index);
                  toggleGroup(group.id);
                }}
              >
                <Icon
                  name={row.collapsed ? 'chevron-right' : 'chevron-down'}
                  className="row-icon"
                />
                <span className="row-label">{group.title}</span>
                <span className="scm-count">{group.items.length}</span>
                {trusted && group.id !== 'conflicts' && (
                  <span className="scm-row-actions">
                    {group.id === 'changes' && (
                      <>
                        <IconButton
                          icon="reset"
                          label="Discard all changes"
                          onClick={(e) => {
                            e.stopPropagation();
                            act(group.items, 'discard');
                          }}
                        />
                        <IconButton
                          icon="plus"
                          label="Stage all changes"
                          onClick={(e) => {
                            e.stopPropagation();
                            void stageAll();
                          }}
                        />
                      </>
                    )}
                    {group.id === 'staged' && (
                      <IconButton
                        icon="minus"
                        label="Unstage all changes"
                        onClick={(e) => {
                          e.stopPropagation();
                          void unstageAll();
                        }}
                      />
                    )}
                  </span>
                )}
              </div>
            );
          }
          const { item } = row;
          const dir = dirname(item.file.relativePath);
          return (
            <div
              id={rowState.id}
              role="treeitem"
              aria-level={2}
              aria-selected={selected.has(item.key)}
              aria-label={`${basename(item.file.path)}, ${item.label}`}
              data-testid={`scm-${item.group}-${basename(item.file.path)}`}
              className={cx(
                'row',
                'scm-item',
                selected.has(item.key) && 'is-selected',
                rowState.active && 'is-active',
                `tone-${item.tone}`,
              )}
              onClick={(e) => {
                onSelect(item, index, e);
                if (!e.shiftKey && !e.ctrlKey && !e.metaKey)
                  void openDiff(item.file.path, item.group === 'staged');
              }}
              onDoubleClick={() =>
                item.file.workingTree !== 'D' &&
                void service('commands').execute('editor.openFile', { path: item.file.path })
              }
              onContextMenu={(e) => {
                e.preventDefault();
                if (!selected.has(item.key)) setSelected(new Set([item.key]));
                rowMenu(e, item);
              }}
            >
              <Icon name={fileIconName(item.file.path)} className="row-icon" />
              <span className={cx('row-label', item.letter === 'D' && 'is-deleted')}>
                {basename(item.file.path)}
              </span>
              <span className="row-description">{dir === '.' ? '' : dir}</span>
              <span className="scm-row-actions">
                {item.file.workingTree !== 'D' && (
                  <IconButton
                    icon="file"
                    label="Open file"
                    onClick={(e) => {
                      e.stopPropagation();
                      void service('commands').execute('editor.openFile', { path: item.file.path });
                    }}
                  />
                )}
                <IconButton
                  icon="git-compare"
                  label="Open changes"
                  onClick={(e) => {
                    e.stopPropagation();
                    void openDiff(item.file.path, item.group === 'staged');
                  }}
                />
                {trusted && item.group === 'changes' && (
                  <>
                    <IconButton
                      icon="reset"
                      label="Discard changes"
                      onClick={(e) => {
                        e.stopPropagation();
                        act([item], 'discard');
                      }}
                    />
                    <IconButton
                      icon="plus"
                      label="Stage changes"
                      onClick={(e) => {
                        e.stopPropagation();
                        act([item], 'stage');
                      }}
                    />
                  </>
                )}
                {trusted && item.group === 'staged' && (
                  <IconButton
                    icon="minus"
                    label="Unstage changes"
                    onClick={(e) => {
                      e.stopPropagation();
                      act([item], 'unstage');
                    }}
                  />
                )}
                {trusted && item.group === 'conflicts' && (
                  <IconButton
                    icon="check"
                    label="Mark as resolved"
                    onClick={(e) => {
                      e.stopPropagation();
                      act([item], 'stage');
                    }}
                  />
                )}
              </span>
              <span className="scm-letter" aria-hidden="true">
                {item.letter}
              </span>
            </div>
          );
        }}
      />
      <span className="sr-only" role="status">
        {plural(total, 'changed file', 'changed files')}
      </span>
    </div>
  );
}
