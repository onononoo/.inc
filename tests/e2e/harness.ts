/**
 * Launches the real Electron app for end-to-end tests.
 *
 * Isolation rules (so many agents and CI jobs can run at once):
 *  - every launch gets its own temporary user-data directory;
 *  - the app directory comes from INC_APP_DIR (build with `node scripts/build.mjs --out .tmp/<name>`),
 *    falling back to ./dist;
 *  - policy defaults to "no policy" via a non-existent INC_POLICY_FILE unless one is supplied.
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');

export interface LaunchOptions {
  /** Folder to open at startup (passed as a CLI argument). */
  workspace?: string;
  /** Administrator policy document to deploy for this launch. */
  policy?: object;
  /** Extra environment variables. */
  env?: Record<string, string>;
  /** Extra command-line arguments after the app directory. */
  args?: string[];
  /** Reuse an existing user-data directory (to test restart behaviour). */
  userDataDir?: string;
  /** Initial window size the test expects; the app is not resized. */
  viewport?: { width: number; height: number };
}

export interface IncInstance {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  /** Console errors and uncaught page errors seen so far. */
  errors: string[];
  screenshot(name: string): Promise<string>;
  /** Invoke a main-process handler the same way the renderer does. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  close(): Promise<void>;
}

export const screenshotDir = path.join(root, 'test-results', 'screens');

export async function launchInc(options: LaunchOptions = {}): Promise<IncInstance> {
  const appDir = path.resolve(root, process.env.INC_APP_DIR ?? 'dist');
  const userDataDir = options.userDataDir ?? mkdtempSync(path.join(os.tmpdir(), 'inc-e2e-'));
  const policyFile = path.join(userDataDir, 'test-policy.json');
  if (options.policy) writeFileSync(policyFile, JSON.stringify(options.policy));

  const app = await electron.launch({
    args: [appDir, ...(options.workspace ? [options.workspace] : []), ...(options.args ?? [])],
    env: {
      ...(process.env as Record<string, string>),
      INC_USER_DATA_DIR: userDataDir,
      INC_POLICY_FILE: options.policy ? policyFile : path.join(userDataDir, 'no-policy.json'),
      ELECTRON_ENABLE_LOGGING: '0',
      INC_TEST_HIDDEN: process.env.INC_TEST_SHOW === '1' ? '0' : '1',
      ...options.env,
    },
  });

  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.waitForLoadState('domcontentloaded');

  mkdirSync(screenshotDir, { recursive: true });

  return {
    app,
    page,
    userDataDir,
    errors,
    async screenshot(name) {
      const file = path.join(screenshotDir, `${name}.png`);
      await page.screenshot({ path: file });
      return file;
    },
    async invoke(channel, ...args) {
      const envelope = await page.evaluate(
        ([c, a]) =>
          (
            window as unknown as {
              inc: { invokeRaw(channel: string, ...args: unknown[]): Promise<unknown> };
            }
          ).inc.invokeRaw(c as string, ...(a as unknown[])),
        [channel, args] as const,
      );
      const env = envelope as {
        ok: boolean;
        value?: unknown;
        error?: { code: string; message: string };
      };
      if (!env.ok) throw new Error(`${env.error?.code}: ${env.error?.message}`);
      return env.value as never;
    },
    async close() {
      await app.close().catch(() => undefined);
      if (!options.userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
