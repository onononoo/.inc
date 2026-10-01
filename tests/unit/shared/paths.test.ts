import { describe, expect, it } from 'vitest';
import {
  basename,
  dirname,
  extname,
  isWithin,
  join,
  pathKey,
  relativeTo,
  samePath,
  segments,
  trimTrailingSeparators,
} from '@shared/paths';

describe('paths', () => {
  it('handles Windows and POSIX styles', () => {
    expect(basename('C:\\repo\\src\\a.ts')).toBe('a.ts');
    expect(basename('/repo/src/a.ts')).toBe('a.ts');
    expect(dirname('C:\\repo\\src\\a.ts')).toBe('C:\\repo\\src');
    expect(dirname('/repo/src/a.ts')).toBe('/repo/src');
    expect(dirname('C:\\a.ts')).toBe('C:\\');
    expect(dirname('/a.ts')).toBe('/');
  });

  it('extracts extensions', () => {
    expect(extname('a/b/file.TS')).toBe('.ts');
    expect(extname('.gitignore')).toBe('');
    expect(extname('archive.tar.gz')).toBe('.gz');
  });

  it('joins using the base path style', () => {
    expect(join('C:\\repo', 'src', 'a.ts')).toBe('C:\\repo\\src\\a.ts');
    expect(join('/repo/', '/src/', 'a.ts')).toBe('/repo/src/a.ts');
  });

  it('keeps roots when trimming separators', () => {
    expect(trimTrailingSeparators('/')).toBe('/');
    expect(trimTrailingSeparators('C:\\')).toBe('C:\\');
    expect(trimTrailingSeparators('/a/b//')).toBe('/a/b');
  });

  it('compares paths per platform case rules', () => {
    expect(samePath('C:\\Repo\\A.ts', 'c:/repo/a.ts', 'win32')).toBe(true);
    expect(samePath('/Repo/A.ts', '/repo/a.ts', 'linux')).toBe(false);
    expect(pathKey('C:\\Repo\\', 'win32')).toBe('c:/repo');
  });

  it('detects containment and relative paths', () => {
    expect(isWithin('/repo', '/repo/src/a.ts', 'linux')).toBe(true);
    expect(isWithin('/repo', '/repository/a.ts', 'linux')).toBe(false);
    expect(relativeTo('C:\\repo', 'C:\\repo\\src\\a.ts', 'win32')).toBe('src/a.ts');
    expect(relativeTo('/repo', '/other/a.ts', 'linux')).toBeNull();
    expect(relativeTo('/repo', '/repo', 'linux')).toBe('');
  });

  it('splits into segments', () => {
    expect(segments('a/b\\c//d')).toEqual(['a', 'b', 'c', 'd']);
  });
});
