import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isIncError } from '@shared/errors';
import {
  clampSize,
  MAX_COLS,
  MAX_COMMAND_LENGTH,
  MAX_NAME_LENGTH,
  MAX_ROWS,
  MAX_WRITE_LENGTH,
  MIN_COLS,
  MIN_ROWS,
  resolveCwd,
  validateAckCount,
  validateInitialCommand,
  validateName,
  validateSize,
  validateTerminalId,
  validateWriteData,
} from '../../../src/main/terminal/validation';
import { tempDir } from './helpers';

const rejects = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isIncError(error, code as never), `expected ${code}, got ${String(error)}`).toBe(true);
};

describe('validateSize', () => {
  it('accepts whole numbers in range', () => {
    expect(validateSize(80, 24)).toEqual({ cols: 80, rows: 24 });
    expect(validateSize(MIN_COLS, MIN_ROWS)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
    expect(validateSize(MAX_COLS, MAX_ROWS)).toEqual({ cols: MAX_COLS, rows: MAX_ROWS });
  });

  it.each([
    [0, 24],
    [80, 0],
    [1, 24],
    [MAX_COLS + 1, 24],
    [80, MAX_ROWS + 1],
    [80.5, 24],
    [Number.NaN, 24],
    [Infinity, 24],
    ['80', 24],
    [undefined, 24],
    [null, null],
    [-5, 10],
  ])('rejects %j x %j', (cols, rows) => {
    expect(() => validateSize(cols, rows)).toThrowError(/terminal size/);
  });
});

describe('clampSize', () => {
  it('clamps and rounds instead of rejecting', () => {
    expect(clampSize(0, 0)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
    expect(clampSize(5000, 5000)).toEqual({ cols: MAX_COLS, rows: MAX_ROWS });
    expect(clampSize(80.6, 24.2)).toEqual({ cols: 81, rows: 24 });
    expect(clampSize(-10, -10)).toEqual({ cols: MIN_COLS, rows: MIN_ROWS });
  });

  it('rejects values that are not numbers', () => {
    expect(() => clampSize('80', 24)).toThrowError(/numbers/);
    expect(() => clampSize(Number.NaN, 24)).toThrowError(/numbers/);
    expect(() => clampSize(80, Infinity)).toThrowError(/numbers/);
  });
});

describe('other arguments', () => {
  it('validates terminal ids', () => {
    expect(validateTerminalId(3)).toBe(3);
    for (const bad of [0, -1, 1.5, '1', null, undefined, Number.NaN]) {
      expect(() => validateTerminalId(bad)).toThrowError(/terminal id/);
    }
  });

  it('validates write data', () => {
    expect(validateWriteData('ls\r')).toBe('ls\r');
    expect(validateWriteData('')).toBe('');
    expect(() => validateWriteData(5)).toThrowError(/must be text/);
    expect(() => validateWriteData('x'.repeat(MAX_WRITE_LENGTH + 1))).toThrowError(/too large/);
  });

  it('validates acknowledged counts', () => {
    expect(validateAckCount(10.9)).toBe(10);
    expect(validateAckCount(0)).toBe(0);
    for (const bad of [-1, Number.NaN, Infinity, '5', undefined]) {
      expect(() => validateAckCount(bad)).toThrowError(/zero or more/);
    }
  });

  it('cleans and limits names', () => {
    expect(validateName(undefined)).toBeUndefined();
    expect(validateName('  build \u001b[31m')).toBe('build [31m');
    expect(validateName('   ')).toBeUndefined();
    expect(() => validateName(5)).toThrowError(/must be text/);
    expect(() => validateName('n'.repeat(MAX_NAME_LENGTH + 1))).toThrowError(/at most/);
  });

  it('validates the initial command and drops trailing line breaks', () => {
    expect(validateInitialCommand(undefined)).toBeUndefined();
    expect(validateInitialCommand('npm test\r\n')).toBe('npm test');
    expect(() => validateInitialCommand(5)).toThrowError(/must be text/);
    expect(() => validateInitialCommand('a\u0000b')).toThrowError(/invalid characters/);
    expect(() => validateInitialCommand('x'.repeat(MAX_COMMAND_LENGTH + 1))).toThrowError(
      /too long/,
    );
  });
});

describe('resolveCwd', () => {
  it('uses the fallback when nothing is requested', async () => {
    const dir = tempDir();
    expect(await resolveCwd(undefined, dir)).toBe(path.normalize(dir));
    expect(await resolveCwd('', dir)).toBe(path.normalize(dir));
  });

  it('accepts an existing absolute folder', async () => {
    const dir = tempDir();
    expect(await resolveCwd(dir, '/unused')).toBe(path.normalize(dir));
  });

  it('rejects a relative path', async () => {
    await rejects(resolveCwd('src', tempDir()), 'E_INVALID');
  });

  it('rejects values that are not paths', async () => {
    await rejects(resolveCwd(5, tempDir()), 'E_INVALID');
    await rejects(resolveCwd('/tmp/a\u0000b', tempDir()), 'E_INVALID');
  });

  it('rejects a folder that does not exist', async () => {
    const dir = tempDir();
    await rejects(resolveCwd(path.join(dir, 'missing'), dir), 'E_NOT_FOUND');
  });

  it('rejects a file', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'x');
    await rejects(resolveCwd(file, dir), 'E_NOT_DIRECTORY');
  });

  it('rejects a missing fallback with a clear message', async () => {
    const dir = tempDir();
    await expect(resolveCwd(undefined, path.join(dir, 'gone'))).rejects.toThrowError(
      /does not exist/,
    );
  });
});
