import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { PolicyState } from '@shared/policy';
import { Emitter, type Logger, type PolicyHost } from '../../../src/main/kernel';
import { parsePolicy } from '../../../src/main/settings/policy-service';

const created: string[] = [];

/** A fresh temporary directory, removed after the current test. */
export function tempDir(prefix = 'inc-settings-'): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function tempFolder(...parts: string[]): string {
  const dir = path.join(tempDir(), ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => void warnings.push(message),
    error: (message) => void warnings.push(message),
  };
}

export async function waitFor(
  check: () => boolean,
  what = 'condition',
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

/** A policy host whose document can be swapped, for tests that do not need the policy file. */
export function fakePolicy(initial: object | null = null): PolicyHost & {
  load(document: object | null): void;
} {
  const emitter = new Emitter<PolicyState>();
  const stateOf = (document: object | null): PolicyState =>
    document === null
      ? parsePolicy('{ "version": 1 }', 'policy.json').state
      : parsePolicy(JSON.stringify(document), 'policy.json').state;
  const host = {
    state: stateOf(initial),
    onDidChange: (cb: (state: PolicyState) => void) => emitter.on(cb),
    load(document: object | null) {
      host.state = stateOf(document);
      emitter.emit(host.state);
    },
  };
  return host;
}
