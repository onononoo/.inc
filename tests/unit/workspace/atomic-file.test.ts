import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  readJsonFileSync,
  writeFileAtomic,
  writeFileAtomicSync,
} from '../../../src/main/workspace/atomic-file';
import { tempDir } from './helpers';

describe('atomic file writes', () => {
  it('creates missing parent folders and replaces existing content (sync)', () => {
    const file = path.join(tempDir(), 'a', 'b', 'state.json');
    writeFileAtomicSync(file, '{"n":1}');
    writeFileAtomicSync(file, '{"n":2}');
    expect(readFileSync(file, 'utf8')).toBe('{"n":2}');
  });

  it('creates missing parent folders and replaces existing content (async)', async () => {
    const file = path.join(tempDir(), 'a', 'state.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
  });

  it('leaves no temporary files behind', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'state.json');
    writeFileAtomicSync(file, 'x');
    await writeFileAtomic(file, 'y');
    expect(readdirSync(dir)).toEqual(['state.json']);
  });

  it('cleans up and rejects when the target cannot be replaced', async () => {
    const dir = tempDir();
    const target = path.join(dir, 'occupied');
    // A directory in the way makes the final rename fail.
    writeFileAtomicSync(path.join(target, 'inner.txt'), 'x');
    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();
    expect(() => writeFileAtomicSync(target, 'data')).toThrow();
    expect(readdirSync(dir)).toEqual(['occupied']);
  });
});

describe('readJsonFileSync', () => {
  it('returns undefined without a complaint for a missing file', () => {
    const problems: string[] = [];
    expect(readJsonFileSync(path.join(tempDir(), 'none.json'), (m) => problems.push(m))).toBe(
      undefined,
    );
    expect(problems).toEqual([]);
  });

  it('parses JSON, tolerating a byte order mark', () => {
    const file = path.join(tempDir(), 's.json');
    writeFileSync(file, '\uFEFF{"a":1}');
    expect(readJsonFileSync(file, () => undefined)).toEqual({ a: 1 });
  });

  it('sets a corrupt file aside and reports it', () => {
    const dir = tempDir();
    const file = path.join(dir, 's.json');
    writeFileSync(file, '{"a":');
    const problems: string[] = [];
    expect(readJsonFileSync(file, (m) => problems.push(m))).toBe(undefined);
    expect(problems).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(['s.json.corrupt']);
  });
});
