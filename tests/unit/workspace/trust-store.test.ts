import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrustStore } from '../../../src/main/workspace/trust-store';
import { hostPlatform, tempDir } from './helpers';

const noop = () => undefined;

describe('TrustStore', () => {
  it('treats unknown folders as untrusted', () => {
    const store = new TrustStore(tempDir(), hostPlatform, noop);
    expect(store.isTrusted(path.join(tempDir(), 'repo'))).toBe(false);
  });

  it('persists grants across instances', () => {
    const userData = tempDir();
    const folder = path.join(tempDir(), 'repo');
    new TrustStore(userData, hostPlatform, noop).set(folder, true);
    expect(new TrustStore(userData, hostPlatform, noop).isTrusted(folder)).toBe(true);
  });

  it('revokes a grant and persists the revocation', () => {
    const userData = tempDir();
    const folder = path.join(tempDir(), 'repo');
    const store = new TrustStore(userData, hostPlatform, noop);
    store.set(folder, true);
    store.set(folder, false);
    expect(store.isTrusted(folder)).toBe(false);
    expect(new TrustStore(userData, hostPlatform, noop).isTrusted(folder)).toBe(false);
  });

  it('does not write when nothing changes', () => {
    const userData = tempDir();
    const store = new TrustStore(userData, hostPlatform, noop);
    store.set(path.join(userData, 'x'), false);
    expect(existsSync(path.join(userData, 'trust.json'))).toBe(false);
  });

  it('does not trust children of a trusted parent', () => {
    const parent = path.join(tempDir(), 'parent');
    const store = new TrustStore(tempDir(), hostPlatform, noop);
    store.set(parent, true);
    expect(store.isTrusted(path.join(parent, 'child'))).toBe(false);
  });

  it('ignores trailing separators', () => {
    const folder = path.join(tempDir(), 'repo');
    const store = new TrustStore(tempDir(), hostPlatform, noop);
    store.set(folder, true);
    expect(store.isTrusted(folder + path.sep)).toBe(true);
  });

  it('compares case-insensitively on Windows and macOS, exactly on Linux', () => {
    const folder = path.join(tempDir(), 'Repo');
    const upper = folder.replace('Repo', 'REPO');
    for (const platform of ['win32', 'darwin'] as const) {
      const store = new TrustStore(tempDir(), platform, noop);
      store.set(folder, true);
      expect(store.isTrusted(upper)).toBe(true);
    }
    const linux = new TrustStore(tempDir(), 'linux', noop);
    linux.set(folder, true);
    expect(linux.isTrusted(upper)).toBe(false);
  });

  it('fails safe when the file is corrupt: nothing is trusted and the file is set aside', () => {
    const userData = tempDir();
    writeFileSync(path.join(userData, 'trust.json'), '{"version":1,"trusted":{');
    const warnings: string[] = [];
    const store = new TrustStore(userData, hostPlatform, (m) => warnings.push(m));
    expect(store.isTrusted(path.join(userData, 'anything'))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(existsSync(path.join(userData, 'trust.json.corrupt'))).toBe(true);
    // The store is still usable afterwards.
    const folder = path.join(userData, 'repo');
    store.set(folder, true);
    expect(new TrustStore(userData, hostPlatform, noop).isTrusted(folder)).toBe(true);
  });

  it('ignores an unknown format version', () => {
    const userData = tempDir();
    const folder = path.join(userData, 'repo');
    writeFileSync(
      path.join(userData, 'trust.json'),
      JSON.stringify({ version: 99, trusted: { [folder]: { path: folder, trustedAt: 1 } } }),
    );
    const warnings: string[] = [];
    const store = new TrustStore(userData, hostPlatform, (m) => warnings.push(m));
    expect(store.isTrusted(folder)).toBe(false);
    expect(warnings).toHaveLength(1);
  });

  it('drops hand-edited records whose key does not match their path', () => {
    const userData = tempDir();
    const folder = path.join(userData, 'repo');
    writeFileSync(
      path.join(userData, 'trust.json'),
      JSON.stringify({
        version: 1,
        trusted: {
          forged: { path: folder, trustedAt: 1 },
          relative: { path: 'relative/path', trustedAt: 1 },
          junk: 5,
        },
      }),
    );
    expect(new TrustStore(userData, hostPlatform, noop).isTrusted(folder)).toBe(false);
  });

  it('stores only grants, with the folder path for diagnostics', () => {
    const userData = tempDir();
    const folder = path.join(userData, 'repo');
    new TrustStore(userData, hostPlatform, noop).set(folder, true);
    const file = JSON.parse(readFileSync(path.join(userData, 'trust.json'), 'utf8'));
    expect(file.version).toBe(1);
    expect(Object.values(file.trusted)).toEqual([{ path: folder, trustedAt: expect.any(Number) }]);
  });

  it('keeps the previous state and throws when the file cannot be written', () => {
    const base = tempDir();
    // The user data "directory" is a file, so creating trust.json beneath it must fail.
    const blocker = path.join(base, 'blocker');
    writeFileSync(blocker, 'x');
    const store = new TrustStore(blocker, hostPlatform, noop);
    const folder = path.join(base, 'repo');
    expect(() => store.set(folder, true)).toThrow();
    expect(store.isTrusted(folder)).toBe(false);
  });
});
