import { create } from 'zustand';

/** Counts of problems in open files, written by the editor slice and read by the panel and status bar. */
interface ProblemCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export const useProblemCounts = create<ProblemCounts>(() => ({ errors: 0, warnings: 0, infos: 0 }));

export function setProblemCounts(counts: ProblemCounts): void {
  const current = useProblemCounts.getState();
  if (
    current.errors === counts.errors &&
    current.warnings === counts.warnings &&
    current.infos === counts.infos
  ) {
    return;
  }
  useProblemCounts.setState(counts);
}
