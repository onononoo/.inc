import { diffLines } from 'diff';

export type GutterKind = 'added' | 'modified' | 'deleted';

export interface GutterMark {
  kind: GutterKind;
  startLine: number;
  endLine: number;
}

/** Files above this size get no gutter, so typing in a huge file never waits for a diff. */
export const GUTTER_MAX_BYTES = 1024 * 1024;

/**
 * Where a document differs from its committed text, as line ranges in the document: added lines,
 * modified lines (a removal followed by an addition) and the line after a pure deletion.
 */
export function gutterMarks(original: string, current: string): GutterMark[] {
  const parts = diffLines(original, current);
  const marks: GutterMark[] = [];
  let line = 1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;
    const count = part.count ?? 0;
    if (part.removed) {
      const next = parts[i + 1];
      if (next?.added) {
        const added = next.count ?? 0;
        marks.push({ kind: 'modified', startLine: line, endLine: line + added - 1 });
        line += added;
        i++;
      } else {
        marks.push({ kind: 'deleted', startLine: line, endLine: line });
      }
    } else if (part.added) {
      marks.push({ kind: 'added', startLine: line, endLine: line + count - 1 });
      line += count;
    } else {
      line += count;
    }
  }
  return marks;
}
