import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FileMatches, SearchMatch } from '@shared/api/search';
import { basename, dirname, relativeTo, type Platform } from '@shared/paths';
import type { MenuItem } from '../contracts/layout';
import { platform as hostPlatform } from '../services/ipc';
import { service } from '../services/registry';
import { useWorkspace } from '../state/workspace-store';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { copyText } from '../ui/clipboard';
import { cx } from '../ui/cx';
import { fileIconName } from '../ui/file-icon';
import { VirtualList } from '../ui/VirtualList';
import {
  clearResults,
  collapseAll,
  dismissFile,
  dismissMatch,
  expandAll,
  readHistory,
  replaceAll,
  replaceInFile,
  runSearch,
  setOptions,
  toggleCollapsed,
  totals,
  useSearchStore,
  cancelSearch,
  type ReplaceSummary,
} from './search-store';
import './search.css';

const platform = hostPlatform as Platform;
const DEBOUNCE_MS = 200;

type Row =
  | { type: 'file'; file: FileMatches; collapsed: boolean }
  | { type: 'match'; file: FileMatches; match: SearchMatch };

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

function summaryText(
  state: ReturnType<typeof useSearchStore.getState>,
  shown: { files: number; matches: number },
): string {
  if (state.error) return state.error;
  if (!state.searched) return '';
  if (state.running && state.files.length === 0) return 'Searching';
  if (shown.matches === 0 && !state.running)
    return 'No results found. Review your exclude settings.';
  const base = `${plural(shown.matches, 'result', 'results')} in ${plural(shown.files, 'file', 'files')}`;
  if (state.running) return `${base} so far`;
  if (state.stats?.limitHit)
    return `${base}. Search limited to ${shown.matches.toLocaleString('en-US')} results`;
  return base;
}

function MatchLine({
  match,
  replacement,
  showReplace,
}: {
  match: SearchMatch;
  replacement: string;
  showReplace: boolean;
}) {
  const lead = match.preview.length - match.preview.trimStart().length;
  const text = match.preview.trimStart();
  const start = Math.max(0, match.previewMatchStart - lead);
  const end = Math.max(start, match.previewMatchEnd - lead);
  return (
    <span className="search-line">
      {text.slice(0, start)}
      {showReplace && replacement !== '' ? (
        <>
          <del className="search-old">{text.slice(start, end)}</del>
          <ins className="search-new">{replacement}</ins>
        </>
      ) : (
        <mark className="search-hit">{text.slice(start, end)}</mark>
      )}
      {text.slice(end)}
    </span>
  );
}

/** The Search view: query and options, replace, include and exclude globs, and streamed results. */
export function SearchView() {
  const state = useSearchStore();
  const workspace = useWorkspace();
  const queryRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const history = useRef({ index: -1 });
  const [selected, setSelected] = useState(-1);

  const shown = useMemo(() => totals(state.files), [state.files]);
  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    for (const file of state.files) {
      const collapsed = state.collapsed.has(file.path);
      list.push({ type: 'file', file, collapsed });
      if (!collapsed) for (const match of file.matches) list.push({ type: 'match', file, match });
    }
    return list;
  }, [state.files, state.collapsed]);

  // Take focus when asked (find in files, find in folder).
  useEffect(() => {
    if (state.focusNonce === 0) return;
    queryRef.current?.focus();
    queryRef.current?.select();
  }, [state.focusNonce]);

  useEffect(() => () => clearTimeout(timer.current), []);

  if (!workspace) {
    return (
      <div className="search-empty">
        <EmptyState
          title="You have not opened a folder"
          description="Open a folder to search in its files."
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

  const schedule = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSearch(), DEBOUNCE_MS);
  };
  const change = (patch: Parameters<typeof setOptions>[0]) => {
    setOptions(patch);
    schedule();
  };

  const open = (file: FileMatches, match: SearchMatch | null, pin: boolean) =>
    void service('commands').execute('editor.openFile', {
      path: file.path,
      ...(match
        ? {
            line: match.line,
            column: match.column,
            endLine: match.line,
            endColumn: match.column + match.length,
          }
        : {}),
      preview: !pin,
      focus: pin,
    });

  const reportReplace = (summary: ReplaceSummary) => {
    const notifications = service('notifications');
    if (summary.skipped.length > 0) {
      notifications.warn(
        `Replaced ${plural(summary.replacements, 'match', 'matches')} in ${plural(summary.filesChanged, 'file', 'files')}. ${plural(summary.skipped.length, 'file was', 'files were')} skipped.`,
        summary.skipped
          .slice(0, 3)
          .map((s) => `${basename(s.path)}: ${s.reason}`)
          .join(' '),
      );
    } else {
      notifications.info(
        `Replaced ${plural(summary.replacements, 'match', 'matches')} in ${plural(summary.filesChanged, 'file', 'files')}.`,
      );
    }
    void runSearch();
  };

  const confirmReplaceAll = async () => {
    if (shown.matches === 0) return;
    const ok = await service('dialogs').confirm({
      title: `Replace ${plural(shown.matches, 'match', 'matches')} in ${plural(shown.files, 'file', 'files')}?`,
      message:
        state.replacement === ''
          ? 'The matches will be removed.'
          : `Each match will be replaced with "${state.replacement}".`,
      detail:
        'Changes to files that are not open cannot be undone. Open files are edited in the editor, where you can undo them.',
      confirmLabel: 'Replace all',
      danger: true,
    });
    if (ok) reportReplace(await replaceAll(state.files));
  };

  const onQueryKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(timer.current);
      void runSearch();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const entries = readHistory();
      if (entries.length === 0) return;
      e.preventDefault();
      const next = Math.min(
        entries.length - 1,
        Math.max(-1, history.current.index + (e.key === 'ArrowUp' ? 1 : -1)),
      );
      history.current.index = next;
      change({ query: next === -1 ? '' : (entries[next] as string) });
    } else if (e.key === 'Escape' && state.running) {
      cancelSearch();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key === 'c') change({ caseSensitive: !state.caseSensitive });
    else if (key === 'w') change({ wholeWord: !state.wholeWord });
    else if (key === 'r') change({ isRegex: !state.isRegex });
    else return;
    e.preventDefault();
  };

  const rowMenu = (event: { clientX: number; clientY: number }, row: Row) => {
    const rel = (p: string) => (workspace ? relativeTo(workspace.root, p, platform) : null) ?? p;
    const items: MenuItem[] = [
      {
        id: 'open',
        label: 'Open',
        run: () => open(row.file, row.type === 'match' ? row.match : null, true),
      },
      {
        id: 'side',
        label: 'Open to the side',
        run: () => {
          open(row.file, row.type === 'match' ? row.match : null, true);
          void service('commands').execute('editor.splitRight');
        },
      },
      {
        id: 'copy',
        label: 'Copy path',
        separatorBefore: true,
        run: () => void copyText(row.file.path),
      },
      { id: 'copyRel', label: 'Copy relative path', run: () => void copyText(rel(row.file.path)) },
      {
        id: 'reveal',
        label: 'Reveal in explorer',
        run: () => void service('commands').execute('explorer.reveal', { path: row.file.path }),
      },
      {
        id: 'dismiss',
        label: 'Dismiss',
        separatorBefore: true,
        run: () =>
          row.type === 'file' ? dismissFile(row.file.path) : dismissMatch(row.file.path, row.match),
      },
    ];
    if (state.replaceOpen) {
      items.push({
        id: 'replace',
        label: row.type === 'file' ? 'Replace in file' : 'Replace',
        run: async () =>
          reportReplace(
            await replaceInFile(row.file, row.type === 'match' ? row.match : undefined),
          ),
      });
    }
    void service('menus').show(items, { x: event.clientX, y: event.clientY });
  };

  const message = summaryText(state, shown);

  return (
    <div className="search" onKeyDown={onKeyDown} data-testid="search-view">
      <div className="search-form">
        <div className="search-row">
          <IconButton
            icon={state.replaceOpen ? 'chevron-down' : 'chevron-right'}
            label={state.replaceOpen ? 'Hide replace' : 'Show replace'}
            className="search-chevron"
            onClick={() => setOptions({ replaceOpen: !state.replaceOpen })}
          />
          <div className="search-field">
            <input
              ref={queryRef}
              className="ui-input search-input"
              aria-label="Search"
              placeholder="Search"
              spellCheck={false}
              value={state.query}
              onChange={(e) => {
                history.current.index = -1;
                change({ query: e.target.value });
              }}
              onKeyDown={onQueryKeyDown}
            />
            <span className="search-toggles">
              <IconButton
                icon="case-sensitive"
                label="Match case"
                shortcut="Alt+C"
                pressed={state.caseSensitive}
                onClick={() => change({ caseSensitive: !state.caseSensitive })}
              />
              <IconButton
                icon="whole-word"
                label="Match whole word"
                shortcut="Alt+W"
                pressed={state.wholeWord}
                onClick={() => change({ wholeWord: !state.wholeWord })}
              />
              <IconButton
                icon="regex"
                label="Use regular expression"
                shortcut="Alt+R"
                pressed={state.isRegex}
                onClick={() => change({ isRegex: !state.isRegex })}
              />
            </span>
          </div>
        </div>

        {state.replaceOpen && (
          <div className="search-row">
            <span className="search-chevron-space" />
            <div className="search-field">
              <input
                className="ui-input search-input"
                aria-label="Replace"
                placeholder="Replace"
                spellCheck={false}
                value={state.replacement}
                onChange={(e) => setOptions({ replacement: e.target.value })}
              />
              <span className="search-toggles">
                <IconButton
                  icon="replace"
                  label="Replace all"
                  disabled={shown.matches === 0}
                  onClick={() => void confirmReplaceAll()}
                />
              </span>
            </div>
          </div>
        )}

        <label className="search-glob">
          <span className="search-glob-label">Files to include</span>
          <input
            className="ui-input"
            aria-label="Files to include"
            placeholder="e.g. src, *.ts"
            spellCheck={false}
            value={state.include}
            onChange={(e) => change({ include: e.target.value })}
          />
        </label>
        <label className="search-glob">
          <span className="search-glob-label">Files to exclude</span>
          <input
            className="ui-input"
            aria-label="Files to exclude"
            placeholder="e.g. **/test/**"
            spellCheck={false}
            value={state.exclude}
            onChange={(e) => change({ exclude: e.target.value })}
          />
        </label>
      </div>

      <div className="search-summary" role="status" aria-live="polite">
        <span className={cx('search-summary-text', state.error && 'is-error')}>{message}</span>
        <span className="search-summary-actions">
          {state.stale && (
            <Button size="sm" variant="ghost" onClick={() => void runSearch()}>
              Search again
            </Button>
          )}
          {state.files.length > 0 && (
            <>
              <IconButton icon="collapse-all" label="Collapse all" onClick={collapseAll} />
              <IconButton icon="expand-all" label="Expand all" onClick={expandAll} />
              <IconButton icon="trash" label="Clear results" onClick={clearResults} />
            </>
          )}
        </span>
      </div>
      {state.stale && (
        <div className="search-note">
          Files changed since this search. The results may be out of date.
        </div>
      )}
      {state.stats?.filesSkipped &&
        state.stats.filesSkipped.binary +
          state.stats.filesSkipped.large +
          state.stats.filesSkipped.unreadable +
          state.stats.filesSkipped.timedOut >
          0 && (
          <div className="search-note">
            Some files were not searched:{' '}
            {[
              state.stats.filesSkipped.large > 0 && `${state.stats.filesSkipped.large} too large`,
              state.stats.filesSkipped.unreadable > 0 &&
                `${state.stats.filesSkipped.unreadable} unreadable`,
              state.stats.filesSkipped.timedOut > 0 &&
                `${state.stats.filesSkipped.timedOut} timed out`,
            ]
              .filter(Boolean)
              .join(', ')}
            .
          </div>
        )}

      <VirtualList
        className="search-results"
        role="tree"
        label="Search results"
        count={rows.length}
        rowHeight={24}
        activeIndex={selected}
        onActiveIndexChange={setSelected}
        onActivate={(index, event) => {
          const row = rows[index];
          if (!row) return;
          if (row.type === 'file') toggleCollapsed(row.file.path);
          else open(row.file, row.match, event.altKey);
        }}
        onKeyDown={(e) => {
          const row = rows[selected];
          if (!row) return;
          if (e.key === 'ArrowRight' && row.type === 'file' && row.collapsed) {
            e.preventDefault();
            toggleCollapsed(row.file.path);
          } else if (e.key === 'ArrowLeft' && row.type === 'file' && !row.collapsed) {
            e.preventDefault();
            toggleCollapsed(row.file.path);
          } else if (e.key === 'Delete') {
            e.preventDefault();
            if (row.type === 'file') dismissFile(row.file.path);
            else dismissMatch(row.file.path, row.match);
          }
        }}
        renderRow={(index, rowState) => {
          const row = rows[index];
          if (!row) return null;
          if (row.type === 'file') {
            const dir = (() => {
              const rel = relativeTo(workspace.root, dirname(row.file.path), platform);
              return rel ?? dirname(row.file.path);
            })();
            return (
              <div
                id={rowState.id}
                role="treeitem"
                aria-level={1}
                aria-expanded={!row.collapsed}
                className={cx('row', 'search-file', rowState.active && 'is-active')}
                onClick={() => {
                  setSelected(index);
                  toggleCollapsed(row.file.path);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  rowMenu(e, row);
                }}
              >
                <Icon
                  name={row.collapsed ? 'chevron-right' : 'chevron-down'}
                  className="row-icon"
                />
                <Icon name={fileIconName(row.file.path)} className="row-icon" />
                <span className="row-label">{basename(row.file.path)}</span>
                <span className="row-description">{dir === '' ? '' : dir}</span>
                <span className="search-count">{row.file.matches.length}</span>
                <span className="search-row-actions">
                  {state.replaceOpen && (
                    <IconButton
                      icon="replace"
                      label="Replace in file"
                      onClick={async (e) => {
                        e.stopPropagation();
                        reportReplace(await replaceInFile(row.file));
                      }}
                    />
                  )}
                  <IconButton
                    icon="close"
                    label="Dismiss"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissFile(row.file.path);
                    }}
                  />
                </span>
              </div>
            );
          }
          return (
            <div
              id={rowState.id}
              role="treeitem"
              aria-level={2}
              className={cx('row', 'search-match', rowState.active && 'is-active')}
              onClick={() => {
                setSelected(index);
                open(row.file, row.match, false);
              }}
              onDoubleClick={() => open(row.file, row.match, true)}
              onContextMenu={(e) => {
                e.preventDefault();
                rowMenu(e, row);
              }}
            >
              <MatchLine
                match={row.match}
                replacement={state.replacement}
                showReplace={state.replaceOpen}
              />
              <span className="search-row-actions">
                {state.replaceOpen && (
                  <IconButton
                    icon="replace"
                    label="Replace"
                    onClick={async (e) => {
                      e.stopPropagation();
                      reportReplace(await replaceInFile(row.file, row.match));
                    }}
                  />
                )}
                <IconButton
                  icon="close"
                  label="Dismiss"
                  onClick={(e) => {
                    e.stopPropagation();
                    dismissMatch(row.file.path, row.match);
                  }}
                />
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}
