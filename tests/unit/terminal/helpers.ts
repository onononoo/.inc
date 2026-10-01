import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { DetectionEnv } from '../../../src/main/terminal/profiles';

const created: string[] = [];

export function tempDir(prefix = 'inc-term-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A machine described by data: the listed files exist, the listed texts can be read. */
export function fakeMachine(
  platform: NodeJS.Platform,
  env: Record<string, string>,
  files: string[],
  texts: Record<string, string> = {},
  links: Record<string, string> = {},
): DetectionEnv {
  const present = new Set(files);
  return {
    platform,
    env,
    isFile: (file) => present.has(file),
    readText: (file) => texts[file] ?? null,
    realPath: (file) => links[file] ?? file,
  };
}
