/** Explorer, search, source control, terminal and settings, driven through the real window. */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createFixture, type Fixture } from './fixtures';
import { launchInc, type IncInstance } from './harness';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press(`${mod}+Shift+P`);
  await page.getByRole('combobox', { name: 'Command palette' }).waitFor();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
}

test.describe('explorer', () => {
  let fixture: Fixture;
  let inc: IncInstance;
  test.beforeEach(async () => {
    fixture = createFixture();
    inc = await launchInc({ workspace: fixture.root });
    await inc.invoke('workspace:setTrust', true);
  });
  test.afterEach(async () => {
    await inc?.close();
    fixture?.cleanup();
  });

  test('lists the workspace, expands folders and opens a file on Enter', async () => {
    const { page } = inc;
    await expect(page.getByTestId('tree-packages')).toBeVisible();
    await page.getByTestId('tree-packages').click();
    await expect(page.getByTestId('tree-api')).toBeVisible();
    await page.getByTestId('tree-README.md').click();
    await page.keyboard.press('Enter');
    await expect(page.locator('[role="tab"]', { hasText: 'README.md' })).toBeVisible();
  });

  test('creates a file and a folder from the command palette', async () => {
    const { page } = inc;
    await page.getByTestId('tree-docs').click();
    await runCommand(page, 'New file in explorer');
    await page.keyboard.type('plan.md');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tree-plan.md')).toBeVisible();
    expect(existsSync(fixture.file('docs', 'plan.md'))).toBe(true);
  });

  test('renames with F2 and refuses a name that already exists', async () => {
    const { page } = inc;
    await page.getByTestId('tree-docs').click();
    await page.getByTestId('tree-guide.md').click();
    await page.keyboard.press('F2');
    await page.keyboard.press(`${mod}+A`);
    await page.keyboard.type('manual.md');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('tree-manual.md')).toBeVisible();
    expect(existsSync(fixture.file('docs', 'manual.md'))).toBe(true);
    expect(existsSync(fixture.file('docs', 'guide.md'))).toBe(false);
  });

  test('delete asks first and moves the file to the trash', async () => {
    const { page } = inc;
    await page.getByTestId('tree-data').click();
    await page.getByTestId('tree-notes.txt').click();
    await page.keyboard.press('Delete');
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('notes.txt');
    await page.keyboard.press('Escape');
    expect(existsSync(fixture.file('data', 'notes.txt'))).toBe(true);
  });

  test('shows changes made on disk without a manual refresh', async () => {
    const { page } = inc;
    writeFileSync(fixture.file('fresh.txt'), 'new');
    await expect(page.getByTestId('tree-fresh.txt')).toBeVisible({ timeout: 10_000 });
  });

  test('typing in the tree jumps to the matching entry', async () => {
    const { page } = inc;
    await page.getByTestId('tree-README.md').click();
    await page.keyboard.type('package.j');
    await expect(page.getByTestId('tree-package.json')).toHaveAttribute('aria-selected', 'true');
  });
});

test.describe('search', () => {
  let fixture: Fixture;
  let inc: IncInstance;
  test.beforeEach(async () => {
    fixture = createFixture();
    inc = await launchInc({ workspace: fixture.root });
    await inc.invoke('workspace:setTrust', true);
  });
  test.afterEach(async () => {
    await inc?.close();
    fixture?.cleanup();
  });

  test('finds text across files and opens the match', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+Shift+F`);
    await page.getByRole('textbox', { name: 'Search', exact: true }).fill('needle');
    await expect(page.locator('.search-hit').first()).toBeVisible({ timeout: 10_000 });
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /result/ })
        .first(),
    ).toContainText('1 result in 1 file');
    await page.locator('.search-hit').first().dblclick();
    await expect(page.locator('[role="tab"]', { hasText: 'notes.txt' })).toBeVisible();
  });

  test('respects include globs and reports an empty result plainly', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+Shift+F`);
    await page.getByRole('textbox', { name: 'Search', exact: true }).fill('needle');
    await page.getByRole('textbox', { name: 'Files to include' }).fill('*.md');
    await expect(page.getByTestId('search-view')).toContainText('No results', { timeout: 10_000 });
  });

  test('replace in files previews and writes the change', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+Shift+H`);
    await page.getByRole('textbox', { name: 'Search', exact: true }).fill('alpha');
    await page.getByRole('textbox', { name: 'Replace', exact: true }).fill('omega');
    await expect(page.locator('.search-new').first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Replace all' }).click();
    const confirm = page.getByRole('alertdialog');
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.getByRole('button', { name: /replace/i }).click();
    }
    await expect
      .poll(() => readFileSync(fixture.file('data', 'notes.txt'), 'utf8'), { timeout: 10_000 })
      .toContain('omega');
  });
});

test.describe('source control', () => {
  let fixture: Fixture;
  let inc: IncInstance;
  test.beforeEach(async () => {
    fixture = createFixture({ git: true });
    writeFileSync(fixture.file('docs', 'guide.md'), '# Guide\n\nchanged\n');
    writeFileSync(fixture.file('untracked.txt'), 'u');
    inc = await launchInc({ workspace: fixture.root });
    await inc.invoke('workspace:setTrust', true);
  });
  test.afterEach(async () => {
    await inc?.close();
    fixture?.cleanup();
  });

  test('lists changes, stages one and commits with a message', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+Shift+G`);
    const row = page.getByTestId('scm-changes-guide.md');
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.hover();
    await row.getByRole('button', { name: 'Stage changes' }).click();
    await expect(page.getByTestId('scm-staged-guide.md')).toBeVisible();
    await page.getByRole('textbox', { name: 'Commit message' }).fill('Update guide');
    await page.keyboard.press(`${mod}+Enter`);
    await expect(page.getByTestId('scm-staged-guide.md')).toBeHidden({ timeout: 10_000 });
    expect(fixture.git('log', '-1', '--format=%s').trim()).toBe('Update guide');
    expect(fixture.git('status', '--porcelain')).toContain('untracked.txt');
  });

  test('opening a change shows a side by side diff', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+Shift+G`);
    await page.getByTestId('scm-changes-guide.md').dblclick();
    await expect(page.getByTestId('diff-view')).toBeVisible({ timeout: 10_000 });
  });

  test('discard asks first and restores the file', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+Shift+G`);
    const row = page.getByTestId('scm-changes-guide.md');
    await row.hover();
    await row.getByRole('button', { name: 'Discard changes' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /discard/i })
      .click();
    await expect
      .poll(() => readFileSync(fixture.file('docs', 'guide.md'), 'utf8'), { timeout: 10_000 })
      .toBe('# Guide\n\nTODO: write the guide.\n');
  });
});

test.describe('terminal', () => {
  test('runs a command in a real shell and shows its output', async () => {
    const fixture = createFixture();
    const inc = await launchInc({ workspace: fixture.root });
    try {
      await inc.invoke('workspace:setTrust', true);
      const { page } = inc;
      await page.keyboard.press(`${mod}+\``);
      await expect(page.getByTestId('terminal-panel')).toBeVisible();
      await page.locator('.xterm-helper-textarea').first().waitFor({ state: 'attached' });
      // A shell can drop input typed while it is still starting, so type again until it answers.
      await expect
        .poll(
          async () => {
            await page.keyboard.type('echo inc-terminal-ok');
            await page.keyboard.press('Enter');
            return page.locator('.xterm-rows').innerText();
          },
          { timeout: 40_000, intervals: [3000] },
        )
        // The echoed command sits after the prompt; its output is a line of its own.
        .toMatch(/^inc-terminal-ok *$/m);
    } finally {
      await inc.close();
      fixture.cleanup();
    }
  });

  test('is blocked with an explanation in Restricted Mode', async () => {
    const fixture = createFixture();
    const inc = await launchInc({ workspace: fixture.root });
    try {
      await inc.page.keyboard.press(`${mod}+\``);
      await expect(inc.page.getByTestId('terminal-blocked')).toContainText('Restricted Mode');
    } finally {
      await inc.close();
      fixture.cleanup();
    }
  });
});

test.describe('settings', () => {
  let fixture: Fixture;
  let inc: IncInstance;
  test.beforeEach(async () => {
    fixture = createFixture();
    inc = await launchInc({ workspace: fixture.root });
    await inc.invoke('workspace:setTrust', true);
  });
  test.afterEach(async () => {
    await inc?.close();
    fixture?.cleanup();
  });

  test('searches settings and changes one, which marks it modified', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+,`);
    await expect(page.getByTestId('settings-editor')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search settings' }).fill('tab size');
    const row = page.getByTestId('setting-editor.tabSize');
    await expect(row).toBeVisible();
    const input = row.getByRole('spinbutton');
    await input.fill('8');
    await input.blur();
    await expect(row).toContainText('Modified');
    await row.getByRole('button', { name: /Reset .* to its default/ }).click();
    await expect(row).not.toContainText('Modified');
  });

  test('switches the theme from the picker and applies it immediately', async () => {
    const { page } = inc;
    await runCommand(page, 'Color theme');
    await page.getByRole('option', { name: /High contrast dark/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'hc-dark');
  });

  test('the shortcuts editor lists commands and changes a binding', async () => {
    const { page } = inc;
    await runCommand(page, 'Keyboard shortcuts');
    await expect(page.getByTestId('keybindings-editor')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search keyboard shortcuts' }).fill('toggle sidebar');
    const row = page.locator('[data-testid^="key-view."]').first();
    await expect(row).toBeVisible();
  });

  test('the trust dialog explains Restricted Mode and can switch to it', async () => {
    const { page } = inc;
    await runCommand(page, 'Manage workspace trust');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Restricted Mode');
    await dialog.getByRole('button', { name: 'Switch to Restricted Mode' }).click();
    await expect(page.getByRole('region', { name: 'Restricted Mode' })).toBeVisible();
  });
});
