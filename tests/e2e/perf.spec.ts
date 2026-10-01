/** Large-folder behaviour: opening, quick open and search stay responsive. */
import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchInc } from './harness';

// The search bound is generous on purpose: the first read of a freshly written file can cost
// 2 ms or more when antivirus scans it (measured: 3,000 new files take 6 s to read once and 85 ms
// to read again), so the time here mostly measures the machine.
test('a folder with 30,000 files opens, indexes and searches quickly', async () => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(os.tmpdir(), 'inc-big-'));
  for (let d = 0; d < 300; d++) {
    const dir = path.join(root, `pkg${d}`, 'src');
    mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 100; f++) {
      writeFileSync(
        path.join(dir, `file${f}.ts`),
        `export const v${d}_${f} = ${f};\n// token${f % 7}\n`,
      );
    }
  }
  const inc = await launchInc({ workspace: root });
  try {
    await inc.invoke('workspace:setTrust', true);
    const t0 = Date.now();
    await expect(inc.page.getByTestId('tree-pkg0')).toBeVisible({ timeout: 10_000 });
    const treeMs = Date.now() - t0;

    const t1 = Date.now();
    await inc.page.keyboard.press('Control+P');
    await inc.page.keyboard.type('pkg250/file42');
    await expect(inc.page.locator('.qi-row').first()).toContainText('file42.ts', {
      timeout: 20_000,
    });
    const quickOpenMs = Date.now() - t1;
    await inc.page.keyboard.press('Escape');

    const t2 = Date.now();
    await inc.page.keyboard.press('Control+Shift+F');
    await inc.page.getByRole('textbox', { name: 'Search', exact: true }).fill('v299_99');
    await expect(inc.page.getByTestId('search-view')).toContainText('1 result', {
      timeout: 120_000,
    });
    const searchMs = Date.now() - t2;

    console.warn(JSON.stringify({ treeMs, quickOpenMs, searchMs }));
    expect(treeMs).toBeLessThan(5_000);
    expect(quickOpenMs).toBeLessThan(10_000);
    expect(searchMs).toBeLessThan(100_000);
  } finally {
    await inc.close();
    rmSync(root, { recursive: true, force: true });
  }
});
