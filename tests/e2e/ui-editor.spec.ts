/** The workbench and the editor, driven through the real window. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createFixture, type Fixture } from './fixtures';
import { launchInc, type IncInstance } from './harness';

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function trust(inc: IncInstance): Promise<void> {
  await inc.invoke('workspace:setTrust', true);
}

/** Open a file the way a person does: quick open, type the name, Enter. */
async function quickOpen(page: Page, name: string): Promise<void> {
  await page.keyboard.press(`${mod}+P`);
  const input = page.getByRole('combobox', { name: /go to file|search|command palette/i }).first();
  await input.waitFor();
  await page.keyboard.type(name);
  await expect(page.locator('.qi-row').first()).toBeVisible();
  await page.keyboard.press('Enter');
}

const tab = (page: Page, label: string): Locator =>
  page.locator(`[role="tab"][data-testid="tab-${label}"]`);
const editorText = (page: Page): Locator => page.locator('.eg-group.is-active .view-lines').first();

test.describe('workbench', () => {
  let fixture: Fixture;
  let inc: IncInstance;
  test.beforeAll(async () => {
    fixture = createFixture();
    inc = await launchInc({ workspace: fixture.root });
    await trust(inc);
  });
  test.afterAll(async () => {
    await inc?.close();
    fixture?.cleanup();
  });

  test('draws the title bar, activity bar, sidebar and status bar', async () => {
    const { page } = inc;
    await expect(page.locator('.wb-brand')).toContainText('.inc');
    for (const name of ['File', 'Edit', 'Selection', 'View', 'Go', 'Terminal', 'Help']) {
      await expect(page.getByRole('menuitem', { name })).toBeVisible();
    }
    await expect(page.getByTestId('activity-explorer')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.wb-command-center-text')).toHaveText(path.basename(fixture.root));
    await expect(page.locator('.wb-statusbar')).toBeVisible();
    expect(inc.errors).toEqual([]);
  });

  test('switching views and toggling the sidebar with the keyboard', async () => {
    const { page } = inc;
    await page.getByTestId('activity-search').click();
    await expect(page.getByTestId('search-view')).toBeVisible();
    await expect(page.getByTestId('activity-search')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press(`${mod}+B`);
    await expect(page.locator('.wb-sidebar-wrap')).toBeHidden();
    await page.keyboard.press(`${mod}+B`);
    await expect(page.locator('.wb-sidebar-wrap')).toBeVisible();
    await page.keyboard.press(`${mod}+Shift+E`);
    await expect(page.getByTestId('activity-explorer')).toHaveAttribute('aria-pressed', 'true');
  });

  test('arrow keys move between activity bar buttons with a single tab stop', async () => {
    const { page } = inc;
    await page.getByTestId('activity-explorer').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('activity-search')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('activity-git')).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.press('Home');
    await expect(page.getByTestId('activity-explorer')).toBeFocused();
    const stops = await page.locator('.wb-activity-group [data-roving][tabindex="0"]').count();
    expect(stops).toBe(1);
  });

  test('resizes the sidebar with the keyboard and remembers the width', async () => {
    const { page } = inc;
    const handle = page.getByRole('separator', { name: 'Resize sidebar' });
    const before = Number(await handle.getAttribute('aria-valuenow'));
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const after = Number(await handle.getAttribute('aria-valuenow'));
    expect(after).toBeGreaterThan(before);
    await page.keyboard.press('Enter');
    expect(Number(await handle.getAttribute('aria-valuenow'))).toBe(264);
  });

  test('the command palette lists commands with shortcuts and runs one', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+Shift+P`);
    const input = page.getByRole('combobox', { name: 'Command palette' });
    await expect(input).toBeFocused();
    await page.keyboard.type('toggle bottom');
    const first = page.locator('.qi-row').first();
    await expect(first).toContainText('Toggle bottom panel');
    await expect(first.locator('.ui-kbd').first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.wb-panel-wrap')).toBeVisible();
    await expect(input).toBeHidden();
    await page.keyboard.press(`${mod}+J`);
    await expect(page.locator('.wb-panel-wrap')).toBeHidden();
  });

  test('Escape closes the palette and focus returns where it was', async () => {
    const { page } = inc;
    await page.getByTestId('activity-explorer').focus();
    await page.keyboard.press(`${mod}+Shift+P`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('combobox', { name: 'Command palette' })).toBeHidden();
    await expect(page.getByTestId('activity-explorer')).toBeFocused();
  });

  test('shows the keyboard shortcut hint while a two-step chord is pending', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+K`);
    await expect(page.locator('.chord-hint')).toContainText('waiting for second key');
    await page.keyboard.press('Escape');
    await expect(page.locator('.chord-hint')).toBeHidden();
  });

  test('About lists versions and the no-telemetry statement', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+Shift+P`);
    await page.keyboard.type('About');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Electron');
    await expect(dialog).toContainText('no telemetry');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('notifications stack, auto-dismiss and can be dismissed', async () => {
    const { page } = inc;
    await page.keyboard.press(`${mod}+Shift+P`);
    await page.keyboard.type('Copy diagnostics');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ui-toast').first()).toContainText('Diagnostics copied');
  });
});

test.describe('editor', () => {
  let fixture: Fixture;
  let inc: IncInstance;
  test.beforeEach(async () => {
    fixture = createFixture();
    fixture.write('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
    inc = await launchInc({ workspace: fixture.root });
    await trust(inc);
  });
  test.afterEach(async () => {
    await inc?.close();
    fixture?.cleanup();
  });

  test('opens a file from quick open, shows highlighting, breadcrumbs and status', async () => {
    const { page } = inc;
    await quickOpen(page, 'server.ts');
    await expect(tab(page, 'server.ts')).toHaveAttribute('aria-selected', 'true');
    await expect(editorText(page)).toContainText('export function start');
    await expect(page.locator('.eg-breadcrumbs')).toContainText('packages');
    await expect(page.getByTestId('status-cursor')).toContainText('Ln 1, Col 1');
    await expect(page.getByTestId('status-language')).toHaveText('TypeScript');
    await expect(page.getByTestId('status-encoding')).toHaveText('UTF-8');
    await expect(page.getByTestId('status-eol')).toHaveText('LF');
    await expect(page.locator('.view-line .mtk1, .view-line [class*="mtk"]').first()).toBeVisible();
  });

  test('typing marks the tab unsaved, saving writes exactly the edited bytes', async () => {
    const { page } = inc;
    await quickOpen(page, 'notes.txt');
    await expect(editorText(page)).toContainText('alpha');
    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type('delta');
    await expect(tab(page, 'notes.txt')).toHaveClass(/is-dirty/);
    await expect(page.locator('title, head')).toBeDefined();
    expect(await page.title()).toContain('● notes.txt');
    await page.keyboard.press(`${mod}+S`);
    await expect(tab(page, 'notes.txt')).not.toHaveClass(/is-dirty/);
    expect(readFileSync(fixture.file('data', 'notes.txt'), 'utf8')).toBe(
      'alpha\nbeta\ngamma\nneedle in a haystack\ndelta',
    );
  });

  test('keeps CRLF line endings and shows them in the status bar', async () => {
    const { page } = inc;
    await quickOpen(page, 'crlf.txt');
    await expect(page.getByTestId('status-eol')).toHaveText('CRLF');
    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type('four');
    await page.keyboard.press(`${mod}+S`);
    await expect(tab(page, 'crlf.txt')).not.toHaveClass(/is-dirty/);
    expect(readFileSync(fixture.file('crlf.txt'), 'utf8')).toBe('one\r\ntwo\r\nthree\r\nfour');
  });

  test('applies EditorConfig: indentation in the status bar and trailing whitespace on save', async () => {
    const { page } = inc;
    fixture.write(
      '.editorconfig',
      'root = true\n[*]\nindent_style = tab\ntab_width = 8\ntrim_trailing_whitespace = true\ninsert_final_newline = true\n',
    );
    fixture.write('ec.txt', 'a\n');
    await quickOpen(page, 'ec.txt');
    await expect(page.getByTestId('status-indent')).toHaveText('Tab size: 8');
    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type('b   ');
    await page.keyboard.press(`${mod}+S`);
    await expect(tab(page, 'ec.txt')).not.toHaveClass(/is-dirty/);
    expect(readFileSync(fixture.file('ec.txt'), 'utf8')).toBe('a\nb\n');
  });

  test('closing an edited tab asks what to do and Cancel keeps it', async () => {
    const { page } = inc;
    await quickOpen(page, 'notes.txt');
    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.type('x');
    await page.keyboard.press(`${mod}+W`);
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('Do you want to save notes.txt?');
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(tab(page, 'notes.txt')).toBeVisible();
    await page.keyboard.press(`${mod}+W`);
    await page.getByRole('button', { name: "Don't save" }).click();
    await expect(tab(page, 'notes.txt')).toBeHidden();
    expect(readFileSync(fixture.file('data', 'notes.txt'), 'utf8')).toBe(
      'alpha\nbeta\ngamma\nneedle in a haystack\n',
    );
  });

  test('preview tabs are replaced by the next one and kept by an edit', async () => {
    const { page } = inc;
    await page.getByTestId('tree-data').click();
    await page.getByTestId('tree-notes.txt').click();
    await expect(tab(page, 'notes.txt')).toHaveClass(/is-preview/);
    await page.getByTestId('tree-docs').click();
    await page.getByTestId('tree-guide.md').click();
    await expect(tab(page, 'guide.md')).toBeVisible();
    await expect(tab(page, 'notes.txt')).toBeHidden();
    await page.getByTestId('tree-guide.md').dblclick();
    await expect(tab(page, 'guide.md')).not.toHaveClass(/is-preview/);
  });

  test('splits the editor and each group keeps its own tabs', async () => {
    const { page } = inc;
    await quickOpen(page, 'server.ts');
    await page.keyboard.press(`${mod}+Shift+P`);
    await page.keyboard.type('split editor right');
    await page.keyboard.press('Enter');
    await expect(page.locator('.eg-group')).toHaveCount(2);
    await expect(page.getByRole('separator', { name: 'Resize editor groups' })).toBeVisible();
    await page.locator('.eg-group').nth(1).getByTestId('tab-close-server.ts').click();
    await expect(page.locator('.eg-group').nth(1).locator('[role="tab"]')).toHaveCount(0);
    await expect(tab(page, 'server.ts')).toHaveCount(1);
  });

  test('an outside change reloads a clean file and flags a conflict on an edited one', async () => {
    const { page } = inc;
    await quickOpen(page, 'notes.txt');
    await expect(editorText(page)).toContainText('alpha');
    writeFileSync(fixture.file('data', 'notes.txt'), 'changed outside\n');
    await expect(editorText(page)).toContainText('changed outside', { timeout: 10_000 });
    await expect(tab(page, 'notes.txt')).not.toHaveClass(/is-dirty/);

    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.type('mine ');
    writeFileSync(fixture.file('data', 'notes.txt'), 'changed again\n');
    await expect(page.locator('.eg-banner.is-warning')).toContainText('changed on disk', {
      timeout: 10_000,
    });
    await expect(page.getByRole('button', { name: 'Compare' }).first()).toBeVisible();
    await page.locator('.eg-banner').getByRole('button', { name: 'Reload' }).click();
    await expect(editorText(page)).toContainText('changed again');
    await expect(page.locator('.eg-banner.is-warning')).toBeHidden();
  });

  test('saving over a file that changed on disk offers overwrite, compare or cancel', async () => {
    const { page } = inc;
    await quickOpen(page, 'notes.txt');
    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.type('mine ');
    const file = fixture.file('data', 'notes.txt');
    writeFileSync(file, 'theirs\n');
    const future = new Date(Date.now() + 60_000);
    utimesSync(file, future, future);
    await page.keyboard.press(`${mod}+S`);
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('changed on disk');
    await page.getByRole('button', { name: 'Compare' }).click();
    await expect(page.getByTestId('diff-view')).toBeVisible();
    expect(readFileSync(file, 'utf8')).toBe('theirs\n');
  });

  test('a deleted file is marked and saving it again recreates it', async () => {
    const { page } = inc;
    await quickOpen(page, 'notes.txt');
    await expect(editorText(page)).toContainText('alpha');
    writeFileSync(fixture.file('data', 'other.txt'), 'x');
    const target = fixture.file('data', 'notes.txt');
    const { rmSync } = await import('node:fs');
    rmSync(target);
    await expect(page.locator('.eg-banner.is-warning')).toContainText('deleted from disk', {
      timeout: 10_000,
    });
    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.type('back');
    await page.keyboard.press(`${mod}+S`);
    await expect(page.locator('.eg-banner.is-warning')).toBeHidden();
    expect(existsSync(target)).toBe(true);
  });

  test('previews images and explains binary and oversized files', async () => {
    const { page } = inc;
    fixture.write(
      'pic.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#336"/></svg>',
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(fixture.file('pic.png'), png);
    writeFileSync(fixture.file('blob.bin'), Buffer.from([1, 2, 0, 3, 0, 0, 5]));
    await quickOpen(page, 'pic.png');
    await expect(page.locator('.eg-image img')).toBeVisible();
    await expect(page.locator('.eg-image-bar')).toContainText('1 × 1');
    await quickOpen(page, 'blob.bin');
    await expect(page.locator('.eg-placeholder')).toContainText('is a binary file');
    expect(inc.errors).toEqual([]);
  });

  test('a file above the size limit opens only on request', async () => {
    const { page } = inc;
    await inc.invoke('settings:set', 'editor.maxFileSizeMB', 1, 'user');
    await inc.invoke('settings:set', 'editor.largeFileThresholdMB', 1, 'user');
    writeFileSync(fixture.file('big.log'), 'x'.repeat(1.5 * 1024 * 1024));
    await quickOpen(page, 'big.log');
    await expect(page.locator('.eg-placeholder')).toContainText('is very large');
    await page.getByRole('button', { name: 'Open anyway' }).click();
    await expect(page.getByTestId('code-editor-1')).toBeVisible();
    await expect(page.locator('.eg-banner.is-info')).toContainText('large file');
  });

  test('go to line moves the cursor and the status bar follows', async () => {
    const { page } = inc;
    await quickOpen(page, 'notes.txt');
    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.press(`${mod}+G`);
    await page.keyboard.type('3');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('status-cursor')).toContainText('Ln 3');
  });

  test('changing the language, line ending and indentation from the status bar', async () => {
    const { page } = inc;
    await quickOpen(page, 'notes.txt');
    await page.getByTestId('status-eol').click();
    await page.getByRole('option', { name: /CRLF/ }).click();
    await expect(page.getByTestId('status-eol')).toHaveText('CRLF');
    await expect(tab(page, 'notes.txt')).toHaveClass(/is-dirty/);
    await page.getByTestId('status-language').click();
    await page.keyboard.type('markdown');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('status-language')).toHaveText('Markdown');
    await page.keyboard.press(`${mod}+S`);
    await expect(tab(page, 'notes.txt')).not.toHaveClass(/is-dirty/);
    expect(readFileSync(fixture.file('data', 'notes.txt'), 'utf8')).toBe(
      'alpha\r\nbeta\r\ngamma\r\nneedle in a haystack\r\n',
    );
  });

  test('restores open tabs and the cursor after a restart', async () => {
    const { page } = inc;
    await quickOpen(page, 'server.ts');
    await quickOpen(page, 'notes.txt');
    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.press(`${mod}+G`);
    await page.keyboard.type('2');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('status-cursor')).toContainText('Ln 2');
    await page.waitForTimeout(2500); // the session is written shortly after a change
    const userDataDir = inc.userDataDir;
    await inc.app.close();
    inc = await launchInc({ workspace: fixture.root, userDataDir });
    await expect(tab(inc.page, 'server.ts')).toBeVisible();
    await expect(tab(inc.page, 'notes.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(inc.page.getByTestId('status-cursor')).toContainText('Ln 2');
  });

  test('shows the welcome page when there is nothing to restore', async () => {
    const fresh = await launchInc();
    try {
      await expect(fresh.page.getByTestId('welcome')).toBeVisible();
      await expect(
        fresh.page.getByTestId('welcome').getByRole('button', { name: 'Open folder' }),
      ).toBeVisible();
      await expect(fresh.page.locator('.welcome-shortcut').first()).toContainText(
        'Command palette',
      );
    } finally {
      await fresh.close();
    }
  });

  test('undo returns an edited file to clean', async () => {
    const { page } = inc;
    await quickOpen(page, 'notes.txt');
    await page.locator('.eg-group.is-active .monaco-editor').first().click();
    await page.keyboard.type('zzz');
    await expect(tab(page, 'notes.txt')).toHaveClass(/is-dirty/);
    await page.keyboard.press(`${mod}+Z`);
    await expect(tab(page, 'notes.txt')).not.toHaveClass(/is-dirty/);
    expect(statSync(fixture.file('data', 'notes.txt')).size).toBeGreaterThan(0);
  });
});
