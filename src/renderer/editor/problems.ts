import { create } from 'zustand';
import type { Problem, Severity } from '../contracts/editor';
import { setProblemCounts } from '../state/problems-store';

/** Problems beyond this are counted but not listed, so a file with 100 000 errors stays usable. */
export const MAX_PROBLEMS = 5000;

/** Monaco's marker severities, kept as plain numbers so this module needs no Monaco import. */
const SEVERITY: Record<number, Severity> = { 1: 'hint', 2: 'info', 4: 'warning', 8: 'error' };
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

export interface RawMarker {
  path: string;
  severity: number;
  message: string;
  source?: string;
  code?: string | { value: string };
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface ProblemSet {
  problems: Problem[];
  truncated: boolean;
  errors: number;
  warnings: number;
  infos: number;
}

/** Turn markers into a sorted, capped problem list with exact counts. */
export function buildProblemSet(markers: readonly RawMarker[], limit = MAX_PROBLEMS): ProblemSet {
  const problems: Problem[] = [];
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const m of markers) {
    const severity = SEVERITY[m.severity];
    if (!severity || severity === 'hint') continue;
    if (severity === 'error') errors++;
    else if (severity === 'warning') warnings++;
    else infos++;
    problems.push({
      path: m.path,
      severity,
      message: m.message,
      source: m.source,
      code: typeof m.code === 'object' ? m.code.value : m.code,
      line: m.startLineNumber,
      column: m.startColumn,
      endLine: m.endLineNumber,
      endColumn: m.endColumn,
    });
  }
  problems.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  const truncated = problems.length > limit;
  return {
    problems: truncated ? problems.slice(0, limit) : problems,
    truncated,
    errors,
    warnings,
    infos,
  };
}

export interface ProblemGroup {
  path: string;
  problems: Problem[];
}

/** Problems grouped by file, files in path order. */
export function groupProblems(problems: readonly Problem[]): ProblemGroup[] {
  const groups: ProblemGroup[] = [];
  for (const problem of problems) {
    const last = groups[groups.length - 1];
    if (last && last.path === problem.path) last.problems.push(problem);
    else groups.push({ path: problem.path, problems: [problem] });
  }
  return groups;
}

interface ProblemsState {
  set: ProblemSet;
}

export const useProblems = create<ProblemsState>(() => ({
  set: { problems: [], truncated: false, errors: 0, warnings: 0, infos: 0 },
}));

/** Publish a new problem set to the panel and the status counts. */
export function publishProblems(set: ProblemSet): void {
  useProblems.setState({ set });
  setProblemCounts({ errors: set.errors, warnings: set.warnings, infos: set.infos });
}
