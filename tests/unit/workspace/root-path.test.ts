import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertOpenableFolder,
  assertOpenableFolderSync,
  isExistingFolderSync,
  normaliseRootInput,
} from '../../../src/main/workspace/root-path';
import { tempDir } from './helpers';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

async function asyncCodeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

describe('normaliseRootInput', () => {
  it.each([[undefined], [null], [42], [{}], [''], ['   ']])('rejects %j', (value) => {
    expect(codeOf(() => normaliseRootInput(value))).toBe('E_INVALID');
  });

  it('rejects relative paths and embedded NUL characters', () => {
    expect(codeOf(() => normaliseRootInput('some/relative'))).toBe('E_INVALID');
    expect(codeOf(() => normaliseRootInput('.'))).toBe('E_INVALID');
    expect(codeOf(() => normaliseRootInput(path.join(tempDir(), 'a\0b')))).toBe('E_INVALID');
  });

  it('rejects absurdly long paths', () => {
    expect(codeOf(() => normaliseRootInput(path.join(tempDir(), 'a'.repeat(40_000))))).toBe(
      'E_INVALID',
    );
  });

  it('resolves dot segments and drops trailing separators', () => {
    const base = tempDir();
    const messy = base + path.sep + 'a' + path.sep + '..' + path.sep + 'b' + path.sep + path.sep;
    expect(normaliseRootInput(messy)).toBe(path.join(base, 'b'));
  });

  it('keeps a file system root intact', () => {
    const root = path.parse(tempDir()).root;
    expect(normaliseRootInput(root)).toBe(root);
  });

  it.runIf(process.platform === 'win32')('rejects drive-relative Windows paths', () => {
    expect(codeOf(() => normaliseRootInput('C:project'))).toBe('E_INVALID');
    expect(codeOf(() => normaliseRootInput('\\project'))).toBe('E_INVALID');
  });
});

describe('folder checks', () => {
  it('accepts an existing folder', async () => {
    const dir = tempDir();
    await expect(assertOpenableFolder(dir)).resolves.toBeUndefined();
    expect(() => assertOpenableFolderSync(dir)).not.toThrow();
    expect(isExistingFolderSync(dir)).toBe(true);
  });

  it('reports E_NOT_FOUND for a missing folder', async () => {
    const missing = path.join(tempDir(), 'missing');
    expect(await asyncCodeOf(() => assertOpenableFolder(missing))).toBe('E_NOT_FOUND');
    expect(codeOf(() => assertOpenableFolderSync(missing))).toBe('E_NOT_FOUND');
    expect(isExistingFolderSync(missing)).toBe(false);
  });

  it('reports E_NOT_DIRECTORY for a file', async () => {
    const file = path.join(tempDir(), 'file.txt');
    writeFileSync(file, 'x');
    expect(await asyncCodeOf(() => assertOpenableFolder(file))).toBe('E_NOT_DIRECTORY');
    expect(codeOf(() => assertOpenableFolderSync(file))).toBe('E_NOT_DIRECTORY');
    expect(isExistingFolderSync(file)).toBe(false);
  });

  it('reports a path below a file as not a directory or not found', async () => {
    const file = path.join(tempDir(), 'file.txt');
    writeFileSync(file, 'x');
    const code = await asyncCodeOf(() => assertOpenableFolder(path.join(file, 'inner')));
    // Windows reports a missing entry, POSIX reports "not a directory".
    expect(['E_NOT_DIRECTORY', 'E_NOT_FOUND']).toContain(code);
  });
});
