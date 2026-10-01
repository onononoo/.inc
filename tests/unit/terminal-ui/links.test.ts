import { describe, expect, it } from 'vitest';
import { findPathLinks, resolveLinkPath } from '../../../src/renderer/terminal/links';

const found = (text: string) =>
  findPathLinks(text).map((l) => [text.slice(l.start, l.end), l.path, l.line, l.column]);

describe('findPathLinks', () => {
  it('finds path, line and column', () => {
    expect(found('error in src/app.ts:12:5 near here')).toEqual([
      ['src/app.ts:12:5', 'src/app.ts', 12, 5],
    ]);
    expect(found('src/app.ts:12')).toEqual([['src/app.ts:12', 'src/app.ts', 12, undefined]]);
  });

  it('understands the parenthesised form used by some compilers', () => {
    expect(found('main.cs(7,3): error CS1002')).toEqual([['main.cs(7,3)', 'main.cs', 7, 3]]);
    expect(found('Program.cs(15)')).toEqual([['Program.cs(15)', 'Program.cs', 15, undefined]]);
  });

  it('finds relative, parent and absolute paths including Windows drives', () => {
    expect(found('./util.ts:3:1')[0]?.[1]).toBe('./util.ts');
    expect(found('../lib/a.ts:9')[0]?.[1]).toBe('../lib/a.ts');
    expect(found('/usr/src/app/main.py:40')[0]?.[1]).toBe('/usr/src/app/main.py');
    expect(found('C:\\work\\app\\main.py:40:2')[0]).toEqual([
      'C:\\work\\app\\main.py:40:2',
      'C:\\work\\app\\main.py',
      40,
      2,
    ]);
  });

  it('finds several links in one line', () => {
    expect(findPathLinks('a.ts:1 and b.ts:2:3').map((l) => l.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('ignores URLs, bare file names without a position and zero lines', () => {
    expect(found('see https://example.com:8080/x.js:12 for details')).toEqual([]);
    expect(found('just src/app.ts here')).toEqual([]);
    expect(found('src/app.ts:0')).toEqual([]);
    expect(found('version 1.2.3:4')).toEqual([]);
  });

  it('does not start in the middle of a word', () => {
    expect(found('xsrc/app.ts:1').map((l) => l[1])).toEqual(['xsrc/app.ts']);
    expect(found('foo@bar.com:25')).toEqual([]);
  });

  it('handles empty and very long lines', () => {
    expect(findPathLinks('')).toEqual([]);
    expect(findPathLinks('a'.repeat(5000) + ' x.ts:1')).toEqual([]);
  });
});

describe('resolveLinkPath', () => {
  it('keeps absolute paths and resolves relative ones against the folder', () => {
    expect(resolveLinkPath('/etc/hosts', '/ws/app', false)).toBe('/etc/hosts');
    expect(resolveLinkPath('src/a.ts', '/ws/app', false)).toBe('/ws/app/src/a.ts');
    expect(resolveLinkPath('./src/a.ts', '/ws/app/', false)).toBe('/ws/app/src/a.ts');
    expect(resolveLinkPath('../lib/b.ts', '/ws/app', false)).toBe('/ws/lib/b.ts');
  });

  it('uses backslashes on Windows and recognises drive and UNC paths', () => {
    expect(resolveLinkPath('src\\a.ts', 'C:\\ws\\app', true)).toBe('C:\\ws\\app\\src\\a.ts');
    expect(resolveLinkPath('D:\\x\\y.ts', 'C:\\ws', true)).toBe('D:\\x\\y.ts');
    expect(resolveLinkPath('..\\y.ts', 'C:\\ws\\app', true)).toBe('C:\\ws\\y.ts');
  });

  it('never climbs above the file system root', () => {
    expect(resolveLinkPath('../../../x.ts', '/a', false)).toBe('/x.ts');
  });
});
