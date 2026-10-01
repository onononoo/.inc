import { describe, expect, it } from 'vitest';
import {
  isAbsolutePathText,
  parseFileQuery,
  parseLineInput,
  routePaletteInput,
} from '../../../src/renderer/commands/palette-query';

describe('palette input routing', () => {
  it('sends ">" to commands, ":" to go to line and anything else to files', () => {
    expect(routePaletteInput('>save')).toEqual({ mode: 'commands', text: 'save' });
    expect(routePaletteInput('>  save  ')).toEqual({ mode: 'commands', text: 'save' });
    expect(routePaletteInput(':42')).toEqual({ mode: 'line', text: '42' });
    expect(routePaletteInput('app.ts')).toEqual({ mode: 'files', text: 'app.ts' });
    expect(routePaletteInput('')).toEqual({ mode: 'files', text: '' });
  });
});

describe('file queries', () => {
  it('reads a line and column suffix', () => {
    expect(parseFileQuery('src/app.ts:42:7')).toEqual({ query: 'src/app.ts', line: 42, column: 7 });
    expect(parseFileQuery('src/app.ts:42')).toEqual({ query: 'src/app.ts', line: 42 });
  });

  it('ignores colons typed on the way to a position', () => {
    expect(parseFileQuery('app.ts:')).toEqual({ query: 'app.ts' });
    expect(parseFileQuery('app.ts::')).toEqual({ query: 'app.ts' });
  });

  it('does not treat a drive letter as a position and uses forward slashes', () => {
    expect(parseFileQuery('C:\\src\\app.ts')).toEqual({ query: 'C:/src/app.ts' });
    expect(parseFileQuery('.\\src\\app.ts')).toEqual({ query: 'src/app.ts' });
    expect(parseFileQuery('./././a.ts')).toEqual({ query: 'a.ts' });
  });

  it('drops a position that is not a positive whole number', () => {
    expect(parseFileQuery('a.ts:0')).toEqual({ query: 'a.ts' });
    expect(parseFileQuery('a.ts:5:0')).toEqual({ query: 'a.ts', line: 5 });
  });

  it('recognises absolute paths', () => {
    expect(isAbsolutePathText('/usr/src/a.ts')).toBe(true);
    expect(isAbsolutePathText('C:\\src\\a.ts')).toBe(true);
    expect(isAbsolutePathText('C:/src/a.ts')).toBe(true);
    expect(isAbsolutePathText('\\\\server\\share\\a.ts')).toBe(true);
    expect(isAbsolutePathText('src/a.ts')).toBe(false);
  });
});

describe('go to line input', () => {
  it('accepts a line with an optional column', () => {
    expect(parseLineInput('42')).toEqual({ kind: 'ok', line: 42 });
    expect(parseLineInput('42:8')).toEqual({ kind: 'ok', line: 42, column: 8 });
    expect(parseLineInput(' 42 , 8 ')).toEqual({ kind: 'ok', line: 42, column: 8 });
  });

  it('reports an empty, malformed or zero line', () => {
    expect(parseLineInput('  ')).toEqual({ kind: 'empty' });
    expect(parseLineInput('abc')).toEqual({ kind: 'invalid', reason: 'format' });
    expect(parseLineInput('4:')).toEqual({ kind: 'invalid', reason: 'format' });
    expect(parseLineInput('0')).toEqual({ kind: 'invalid', reason: 'zero' });
  });
});
