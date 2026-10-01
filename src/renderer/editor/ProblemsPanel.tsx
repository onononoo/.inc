import { useMemo, useState } from 'react';
import { basename, dirname, relativeTo } from '@shared/paths';
import type { Problem } from '../contracts/editor';
import { platform } from '../services/ipc';
import { service } from '../services/registry';
import { useWorkspace } from '../state/workspace-store';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { Input } from '../ui/Input';
import { VirtualList } from '../ui/VirtualList';
import { groupProblems, useProblems } from './problems';

type Row =
  | { type: 'file'; path: string; count: number; collapsed: boolean }
  | { type: 'problem'; problem: Problem };

const SEVERITY_ICON = {
  error: 'x-circle',
  warning: 'alert-triangle',
  info: 'info',
  hint: 'info',
} as const;

function matches(problem: Problem, filter: string): boolean {
  if (!filter) return true;
  const needle = filter.toLowerCase();
  return (
    problem.message.toLowerCase().includes(needle) ||
    problem.path.toLowerCase().includes(needle) ||
    (problem.source ?? '').toLowerCase().includes(needle) ||
    (problem.code ?? '').toLowerCase().includes(needle)
  );
}

/** Problems in the open files, grouped by file; click one to open its location. */
export function ProblemsPanel() {
  const set = useProblems((s) => s.set);
  const workspace = useWorkspace();
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = [];
    for (const group of groupProblems(set.problems.filter((p) => matches(p, filter)))) {
      const isCollapsed = collapsed.has(group.path);
      list.push({
        type: 'file',
        path: group.path,
        count: group.problems.length,
        collapsed: isCollapsed,
      });
      if (!isCollapsed)
        for (const problem of group.problems) list.push({ type: 'problem', problem });
    }
    return list;
  }, [set.problems, filter, collapsed]);

  const toggle = (path: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const open = (problem: Problem) =>
    void service('commands').execute('editor.openFile', {
      path: problem.path,
      line: problem.line,
      column: problem.column,
      endLine: problem.endLine,
      endColumn: problem.endColumn,
    });

  const relative = (path: string) => {
    const rel = workspace ? relativeTo(workspace.root, dirname(path), platform as never) : null;
    return rel ?? dirname(path);
  };

  const total = set.errors + set.warnings + set.infos;

  return (
    <div className="problems" data-testid="problems-panel">
      <div className="problems-bar">
        <Input
          aria-label="Filter problems"
          placeholder="Filter by text, file or source"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="problems-summary" role="status">
          {total === 0
            ? 'No problems'
            : `${set.errors} ${set.errors === 1 ? 'error' : 'errors'}, ${set.warnings} ${set.warnings === 1 ? 'warning' : 'warnings'}`}
        </span>
        <IconButton
          icon="collapse-all"
          label="Collapse all"
          disabled={rows.length === 0}
          onClick={() => setCollapsed(new Set(set.problems.map((p) => p.path)))}
        />
      </div>
      <VirtualList
        className="problems-list"
        label="Problems"
        role="tree"
        count={rows.length}
        rowHeight={24}
        empty={
          <EmptyState
            title="No problems have been detected in the open files."
            description={filter ? 'No problem matches the filter.' : undefined}
          />
        }
        onActivate={(index) => {
          const row = rows[index];
          if (!row) return;
          if (row.type === 'file') toggle(row.path);
          else open(row.problem);
        }}
        renderRow={(index, state) => {
          const row = rows[index];
          if (!row) return null;
          if (row.type === 'file') {
            return (
              <div
                id={state.id}
                role="treeitem"
                aria-expanded={!row.collapsed}
                aria-level={1}
                className={`row problems-file${state.active ? ' is-active' : ''}`}
                onClick={() => toggle(row.path)}
              >
                <Icon
                  name={row.collapsed ? 'chevron-right' : 'chevron-down'}
                  className="row-icon"
                />
                <span className="row-label">{basename(row.path)}</span>
                <span className="row-description">{relative(row.path)}</span>
                <span className="problems-count">{row.count}</span>
              </div>
            );
          }
          const { problem } = row;
          return (
            <div
              id={state.id}
              role="treeitem"
              aria-level={2}
              className={`row problems-item${state.active ? ' is-active' : ''}`}
              onClick={() => open(problem)}
            >
              <Icon
                name={SEVERITY_ICON[problem.severity]}
                className={`problems-icon is-${problem.severity}`}
              />
              <span className="row-label problems-message" title={problem.message}>
                {problem.message}
              </span>
              {(problem.source || problem.code) && (
                <span className="row-description">
                  {[problem.source, problem.code].filter(Boolean).join(' ')}
                </span>
              )}
              <span className="problems-pos">
                [{problem.line}, {problem.column}]
              </span>
            </div>
          );
        }}
      />
      {set.truncated && (
        <div className="problems-note" role="status">
          Showing the first {set.problems.length.toLocaleString('en-US')} problems. Fix some to see
          more.
        </div>
      )}
    </div>
  );
}
