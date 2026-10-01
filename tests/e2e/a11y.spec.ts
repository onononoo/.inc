/** Automated accessibility checks (axe-core) across views and themes. */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFixture, type Fixture } from './fixtures';
import { launchInc, type IncInstance } from './harness';

const axeSource = readFileSync(
  path.resolve(__dirname, '../../node_modules/axe-core/axe.min.js'),
  'utf8',
);
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

interface Violation {
  id: string;
  impact: string | null;
  nodes: { target: unknown; html?: string }[];
}

async function audit(page: Page): Promise<Violation[]> {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Violation[] }> };
      }
    ).axe;
    return axe.run(document, {
      // Monaco draws its own text layers and is audited by its authors.
      exclude: [['.monaco-editor']],
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
  });
  // Splitters are separators between landmarks and tooltips are transient popups; neither belongs in a region.
  return result.violations
    .map((v) => ({
      ...v,
      nodes:
        v.id === 'region'
          ? v.nodes.filter(
              (n) => !/ui-splitter|role="tooltip"/.test(JSON.stringify(n.target) + (n.html ?? '')),
            )
          : v.nodes,
    }))
    .filter((v) => v.nodes.length > 0);
}

function describe(violations: Violation[]): string {
  return violations
    .map(
      (v) =>
        `${v.id} (${v.impact}): ` +
        v.nodes
          .slice(0, 3)
          .map((n) => `${JSON.stringify(n.target)} ${n.html?.slice(0, 140) ?? ''}`)
          .join(' | '),
    )
    .join('\n');
}

const THEMES = ['light', 'dark', 'hc-light', 'hc-dark'] as const;

test.describe('accessibility', () => {
  let fixture: Fixture;
  let inc: IncInstance;
  test.beforeEach(async () => {
    fixture = createFixture({ git: true });
    writeFileSync(fixture.file('docs', 'guide.md'), '# Guide\n\nchanged\n');
    inc = await launchInc({ workspace: fixture.root });
    await inc.invoke('workspace:setTrust', true);
  });
  test.afterEach(async () => {
    await inc?.close();
    fixture?.cleanup();
  });

  for (const theme of THEMES) {
    test(`views have no violations in ${theme}`, async () => {
      const { page } = inc;
      await inc.invoke('settings:set', 'appearance.theme', theme, 'user');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      // Colors transition when the theme changes; measure the settled colors.
      await page.addStyleTag({
        content: '*, *::before, *::after { transition: none !important; }',
      });
      const problems: string[] = [];
      const check = async (name: string) => {
        const found = await audit(page);
        if (found.length > 0) problems.push(`[${name}]\n${describe(found)}`);
      };

      await check('explorer');
      await page.keyboard.press(`${mod}+Shift+F`);
      await page.getByRole('textbox', { name: 'Search', exact: true }).fill('needle');
      await expect(page.locator('.search-hit').first()).toBeVisible({ timeout: 10_000 });
      await check('search');
      await page.keyboard.press(`${mod}+Shift+G`);
      await expect(page.getByTestId('scm-changes-guide.md')).toBeVisible({ timeout: 10_000 });
      await check('source control');
      await page.keyboard.press(`${mod}+Shift+E`);
      await page.keyboard.press(`${mod}+P`);
      await page.getByRole('combobox', { name: 'Go to file' }).waitFor();
      await page.keyboard.type('notes');
      await expect(page.locator('.qi-row').first()).toBeVisible();
      await check('quick open');
      await page.keyboard.press('Enter');
      await expect(page.locator('[role="tab"]', { hasText: 'notes.txt' })).toBeVisible();
      await check('editor');
      await page.keyboard.press(`${mod}+,`);
      await expect(page.getByTestId('settings-editor')).toBeVisible();
      await check('settings');
      await page.keyboard.press(`${mod}+K`);
      await page.keyboard.press(`${mod}+S`);
      await expect(page.getByTestId('keybindings-editor')).toBeVisible();
      await check('keyboard shortcuts');

      expect(problems.join('\n\n'), problems.join('\n\n')).toBe('');
    });
  }
});
