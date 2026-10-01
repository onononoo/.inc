import { BrowserWindow, app, dialog, shell } from 'electron';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { OpenDialogOptions } from 'electron';
import type { MenuName } from '@shared/api/window';
import type { SettingKey } from '@shared/settings';
import type { Disposable, Kernel } from '../kernel';
import { buildDiagnostics } from './diagnostics';
import { cleanFilters, cleanMessageBox, cleanTitle } from './dialog-options';
import { openExternalLink } from './external-links';
import { LogBudget, cleanLogLevel, cleanLogMessage } from './log-sink';
import { MENU_ORDER } from './menu';
import { securityStats } from './security-stats';
import {
  optionalAbsolutePath,
  optionalObject,
  requireFiniteNumber,
  requireOneOf,
  requireString,
} from './validate';
import { normalizeCssColor } from './css-color';
import { WindowManager } from './windows';

const MIN_ZOOM = -3;
const MAX_ZOOM = 5;

let manager: WindowManager | null = null;

/**
 * Open windows for a command line: the first launch, a second instance, or a path the operating
 * system handed over. Does nothing until the shell slice has registered.
 */
export function launch(argv: readonly string[], cwd: string, options: { initial?: boolean } = {}) {
  manager?.launch(argv, cwd, options);
}

/** Open an empty window when none exists (macOS dock activation). */
export function ensureWindow(): void {
  if (manager && BrowserWindow.getAllWindows().length === 0) manager.create();
}

function windowOf(windowId: number): BrowserWindow {
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) throw new Error('The window is no longer available.');
  return win;
}

/**
 * Shell slice: application menu, window management, dialogs, safe close and quit, launch handling,
 * external links, diagnostics and the renderer log sink.
 */
export function register(kernel: Kernel): Disposable {
  const windows = new WindowManager(kernel);
  manager = windows;
  windows.installMenu();

  const budgets = new Map<number, LogBudget>();
  const subscriptions = [
    kernel.policy.onDidChange(() => windows.installMenu()),
    kernel.onWindowClosed((id) => budgets.delete(id)),
  ];

  const onBeforeQuit = (event: Electron.Event) => {
    if (windows.isQuitting()) {
      windows.flush();
      return;
    }
    event.preventDefault();
    windows.quit.begin();
  };
  app.on('before-quit', onBeforeQuit);

  // --- app ----------------------------------------------------------------------------------

  kernel.handle('app:getInfo', () => kernel.info);

  kernel.handle('app:getDiagnostics', ({ windowId }) => {
    const policy = kernel.policy.state;
    const snapshot = kernel.settings.snapshot(windowId);
    let sources: Record<'default' | 'user' | 'workspace' | 'policy', number> | null = null;
    if (snapshot) {
      sources = { default: 0, user: 0, workspace: 0, policy: 0 };
      for (const key of Object.keys(snapshot.sources) as SettingKey[])
        sources[snapshot.sources[key]]++;
    }
    return buildDiagnostics({
      generatedAt: new Date(),
      app: {
        name: kernel.info.name,
        version: kernel.info.version,
        packaged: kernel.info.isPackaged,
      },
      versions: {
        electron: kernel.info.electron,
        chrome: kernel.info.chrome,
        node: kernel.info.node,
      },
      system: {
        platform: kernel.info.platform,
        arch: kernel.info.arch,
        osType: os.type(),
        osRelease: os.release(),
        locale: kernel.info.locale,
        cpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      policy: {
        active: policy.active,
        file: policy.file,
        lockedKeyCount: policy.lockedKeys.length,
        warnings: policy.warnings,
        externalLinks: policy.features.externalLinks,
        terminal: policy.features.terminal,
        tasks: policy.features.tasks,
        gitRemoteOperations: policy.features.gitRemoteOperations,
      },
      settingSources: sources,
      settingIssueCount: snapshot ? snapshot.issues.length : null,
      blockedNetworkRequests: securityStats.blockedRequests(),
      blockedNavigations: securityStats.blockedNavigations(),
      userDataDir: kernel.info.userDataDir,
      logDir: kernel.info.logDir,
      windowCount: BrowserWindow.getAllWindows().length,
      homeDir: os.homedir(),
    });
  });

  kernel.handle('app:openExternal', ({ windowId }, raw) =>
    openExternalLink(raw, {
      mode: kernel.policy.state.features.externalLinks,
      confirm: async (address) => {
        const parent = BrowserWindow.fromId(windowId);
        const options = {
          type: 'question' as const,
          message: 'Open this link in your browser?',
          detail: address,
          buttons: ['Open', 'Cancel'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const { response } = parent
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
        return response === 0;
      },
      open: (href) => shell.openExternal(href),
      log: (level, message) => kernel.logger[level](message),
    }),
  );

  kernel.handle('app:showLogs', async () => {
    const failure = await shell.openPath(kernel.info.logDir);
    if (failure) kernel.logger.warn(`Could not open the log folder: ${failure}`);
  });

  kernel.handle('app:getNoticesPath', () => {
    const roots = [
      process.resourcesPath,
      join(app.getAppPath(), '..'),
      join(app.getAppPath(), '..', '..'),
    ];
    return roots.map((r) => join(r, 'THIRD_PARTY_NOTICES.md')).find((p) => existsSync(p)) ?? null;
  });

  kernel.handle('app:log', ({ windowId }, level, message) => {
    const safeLevel = cleanLogLevel(level);
    const text = cleanLogMessage(message);
    let budget = budgets.get(windowId);
    if (!budget) {
      budget = new LogBudget();
      budgets.set(windowId, budget);
    }
    const { decision, dropped } = budget.take(Date.now());
    if (decision === 'drop') return;
    if (decision === 'dropped-summary') {
      kernel.logger.warn(`Renderer log messages dropped by the rate limit: ${dropped}`);
    }
    kernel.logger[safeLevel](`[renderer] ${text}`);
  });

  kernel.handle('app:quit', () => windows.quit.begin());
  kernel.handle('app:consumePendingOpen', ({ windowId }) => windows.consumePendingOpen(windowId));

  // --- window -------------------------------------------------------------------------------

  kernel.handle('window:getState', ({ windowId }) => windows.state(windowId));

  kernel.handle('window:control', ({ windowId }, action) => {
    const win = windowOf(windowId);
    switch (
      requireOneOf(
        action,
        ['minimize', 'maximize', 'restore', 'close', 'toggleFullscreen'],
        'action',
      )
    ) {
      case 'minimize':
        win.minimize();
        break;
      case 'maximize':
        win.maximize();
        break;
      case 'restore':
        if (win.isFullScreen()) win.setFullScreen(false);
        else win.restore();
        break;
      case 'close':
        windows.requestClose(windowId);
        break;
      case 'toggleFullscreen':
        win.setFullScreen(!win.isFullScreen());
        break;
    }
  });

  kernel.handle('window:setTitle', ({ windowId }, title) => {
    windowOf(windowId).setTitle(requireString(title, 'title', 512));
  });

  kernel.handle('window:setDocumentEdited', ({ windowId }, edited) => {
    if (process.platform === 'darwin') windowOf(windowId).setDocumentEdited(edited === true);
  });

  kernel.handle('window:setTheme', ({ windowId }, scheme, colors) => {
    const safeScheme = requireOneOf(scheme, ['light', 'dark'], 'scheme');
    const record = optionalObject(colors, 'colors');
    const background = normalizeCssColor(record.background);
    const foreground = normalizeCssColor(record.foreground);
    if (!background || !foreground) return;
    windows.applyTheme(windowId, safeScheme, background, foreground);
  });

  kernel.handle('window:setZoom', ({ windowId }, level) => {
    const value = requireFiniteNumber(level, 'level');
    windowOf(windowId).webContents.setZoomLevel(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)));
  });

  kernel.handle('window:new', (_ctx, folder) => {
    windows.create({ folder: optionalAbsolutePath(folder, 'folder') ?? null });
  });

  kernel.handle('window:reload', ({ windowId }) => windowOf(windowId).webContents.reload());
  kernel.handle('window:toggleDevTools', ({ windowId }) =>
    windowOf(windowId).webContents.toggleDevTools(),
  );

  kernel.handle('window:showMenu', ({ windowId }, menu, x, y) => {
    const name = requireOneOf(menu, MENU_ORDER as readonly MenuName[], 'menu');
    windows.showMenu(windowId, name, requireFiniteNumber(x, 'x'), requireFiniteNumber(y, 'y'));
  });

  kernel.handle('window:confirmClose', ({ windowId }) => windows.confirmClose(windowId));

  // --- dialogs ------------------------------------------------------------------------------

  kernel.handle('dialog:openFolder', async ({ windowId }, rawOptions) => {
    const options = optionalObject(rawOptions, 'options');
    const dialogOptions: OpenDialogOptions = {
      title: cleanTitle(options.title),
      defaultPath: optionalAbsolutePath(options.defaultPath, 'defaultPath'),
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = await dialog.showOpenDialog(windowOf(windowId), dialogOptions);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  kernel.handle('dialog:openFiles', async ({ windowId }, rawOptions) => {
    const options = optionalObject(rawOptions, 'options');
    const result = await dialog.showOpenDialog(windowOf(windowId), {
      title: cleanTitle(options.title),
      defaultPath: optionalAbsolutePath(options.defaultPath, 'defaultPath'),
      filters: cleanFilters(options.filters),
      properties: options.multiple === false ? ['openFile'] : ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : result.filePaths;
  });

  kernel.handle('dialog:saveAs', async ({ windowId }, rawOptions) => {
    const options = optionalObject(rawOptions, 'options');
    const result = await dialog.showSaveDialog(windowOf(windowId), {
      title: cleanTitle(options.title),
      defaultPath: optionalAbsolutePath(options.defaultPath, 'defaultPath'),
      filters: cleanFilters(options.filters),
    });
    return result.canceled ? null : (result.filePath ?? null);
  });

  kernel.handle('dialog:message', async ({ windowId }, rawOptions) => {
    const options = cleanMessageBox(rawOptions);
    const result = await dialog.showMessageBox(windowOf(windowId), { ...options, noLink: true });
    return { response: result.response, checkboxChecked: result.checkboxChecked };
  });

  return () => {
    for (const off of subscriptions) off();
    app.off('before-quit', onBeforeQuit);
    manager = null;
  };
}
