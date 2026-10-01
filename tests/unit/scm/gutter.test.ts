import { describe, expect, it } from 'vitest';
import { gutterMarks } from '../../../src/renderer/scm/gutter';

describe('gutterMarks', () => {
  it('finds nothing for identical text', () => {
    expect(gutterMarks('a\nb\nc\n', 'a\nb\nc\n')).toEqual([]);
  });

  it('marks added lines', () => {
    expect(gutterMarks('a\nc\n', 'a\nb\nc\n')).toEqual([
      { kind: 'added', startLine: 2, endLine: 2 },
    ]);
    expect(gutterMarks('a\n', 'a\nb\nc\n')).toEqual([{ kind: 'added', startLine: 2, endLine: 3 }]);
  });

  it('marks changed lines as modified', () => {
    expect(gutterMarks('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { kind: 'modified', startLine: 2, endLine: 2 },
    ]);
    expect(gutterMarks('a\nb\nc\nd\n', 'a\nX\nY\nd\n')).toEqual([
      { kind: 'modified', startLine: 2, endLine: 3 },
    ]);
  });

  it('marks the line after a deletion', () => {
    expect(gutterMarks('a\nb\nc\n', 'a\nc\n')).toEqual([
      { kind: 'deleted', startLine: 2, endLine: 2 },
    ]);
  });

  it('treats a whole new file as added and an emptied file as deleted', () => {
    expect(gutterMarks('', 'x\ny\n')).toEqual([{ kind: 'added', startLine: 1, endLine: 2 }]);
    expect(gutterMarks('x\ny\n', '')).toEqual([{ kind: 'deleted', startLine: 1, endLine: 1 }]);
  });

  it('reports several separate changes in document order', () => {
    const marks = gutterMarks('1\n2\n3\n4\n5\n6\n', '1\nTWO\n3\n4\n6\n7\n');
    expect(marks.map((m) => [m.kind, m.startLine, m.endLine])).toEqual([
      ['modified', 2, 2],
      ['deleted', 5, 5],
      ['added', 6, 6],
    ]);
  });
});
