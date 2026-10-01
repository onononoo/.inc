import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  nativeTheme,
  screen,
  type MenuItemConstructorOptions,
} from 'electron';
import fs from 'node:fs';
import type { OpenPathsRequest } from '@shared/api/app';
import type { MenuName, WindowState } from '@shared/api/window';
import { COMMANDS } from '@shared/commands/catalog';
import type { Platform } from '@shared/paths';
import type { Kernel } from '../kernel';
import { createWindow, fallbackAppearance, hiddenForTests, type WindowAppearance } from '../window';
import { parseLaunchArgs, type LaunchRequest, type OpenTarget } from './argv';
import { CloseCoordinator } from './close-coordinator';
import { groupOpenRequests, PendingOpenQueue, planLaunch, type LaunchContext } from './launch-plan';
import {
  buildSubmenu,
  buildMenuTemplate,
  type MenuInput,
  type MenuRole,
  type MenuTemplateItem,
} from './menu';
import { QuitCoordinator } from './quit-coordinator';
import {
  CrashTracker,
  choiceFor,
  recoveryDialog,
  type GoneReason,
  type RecoveryKind,
} from './recovery';
import { getShellStateStore, type ShellStateStore } from './window-state-store';
import { resolvePlacement, type Rect } from './window-state';

const ROLE_MAP: Record<MenuRole, MenuItemConstructorOptions['role']> = {
  services: 'services',
  hide: 'hide',
  hideOthers: 'hideOthers',
  unhide: 'unhide',
  minimize: 'minimize',
  zoom: 'zoom',
  front: 'front',
};

/** Tests that exercise the close handshake opt in; every other hidden run closes straight away. */
const handshakeEnabled = !hiddenForTests || process.env.INC_TEST_HANDSHAKE === '1';

function stat(target: string): 'file' | 'directory' | null {
  try {
    const info = fs.statSync(target);
    return info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
  } catch {
    return null;
  }
}

function rectOf(win: BrowserWindow): Rect {
  const { x, y, width, height } = win.getNormalBounds();
  return { x, y, width, height };
}

/**
 * Owns the application's windows: where they open, how they close, what they hear from the
 * operating system, and which window each folder or file of a launch request goes to.
 */
export class WindowManager {
  private readonly store: ShellStateStore;
  private readonly pending = new PendingOpenQueue();
  private readonly coordinators = new Map<number, CloseCoordinator>();
  private readonly ready = new Set<number>();
  private readonly unresponsive = new Set<number>();
  private readonly crashes = new Map<number, CrashTracker>();
  private readonly quitDriven = new Set<number>();
  private readonly platform: Platform;
  private lastFocused: number | null = null;
  private quitting = false;
  readonly quit: QuitCoordinator;

  constructor(private readonly kernel: Kernel) {
    this.store = getShellStateStore(kernel);
    this.platform = kernel.info.platform;
    this.quit = new QuitCoordinator({
      windowIds: () => this.liveWindows().map((w) => w.id),
      requestClose: (id) => {
        this.quitDriven.add(id);
        BrowserWindow.fromId(id)?.close();
      },
      quitNow: () => {
        this.quitting = true;
        app.quit();
      },
    });
  }

  // --- creating windows ---------------------------------------------------------------------

  private liveWindows(): BrowserWindow[] {
    return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  }

  private appearance(): WindowAppearance {
    return this.store.get().theme ?? fallbackAppearance();
  }

  /** Open a window, optionally on a folder. */
  create(options: { folder?: string | null } = {}): BrowserWindow {
    const existing = this.liveWindows();
    const parent =
      existing.find((w) => w.id === this.lastFocused) ?? existing[existing.length - 1] ?? null;
    const placement = resolvePlacement({
      saved: parent ? null : this.store.get().window,
      cascadeFrom: parent ? rectOf(parent) : null,
      displays: screen.getAllDisplays().map((d) => d.workArea),
      primary: screen.getPrimaryDisplay().workArea,
    });
    const win = createWindow(this.kernel, {
      ...placement,
      appearance: this.appearance(),
    });
    this.attach(win);
    if (options.folder) this.openFolder(win.id, options.folder);
    return win;
  }

  private openFolder(windowId: number, folder: string): void {
    try {
      this.kernel.workspaces.setRoot(windowId, folder);
    } catch (error) {
      this.kernel.logger.warn(`Could not open the folder from the command line`, error);
    }
  }

  // --- per-window behaviour -----------------------------------------------------------------

  private stateOf(win: BrowserWindow): WindowState {
    return {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      focused: win.isFocused(),
      platform: this.platform,
      nativeControls: true,
    };
  }

  /** Current state, for `window:getState`. */
  state(windowId: number): WindowState {
    const win = BrowserWindow.fromId(windowId);
    if (!win) {
      return {
        maximized: false,
        fullscreen: false,
        focused: false,
        platform: this.platform,
        nativeControls: true,
      };
    }
    return this.stateOf(win);
  }

  private sendState(win: BrowserWindow): void {
    if (win.isDestroyed()) return;
    this.kernel.send(win.id, 'window:stateChanged', this.stateOf(win));
  }

  private remember(win: BrowserWindow): void {
    if (win.isDestroyed() || win.isMinimized()) return;
    const bounds = win.getNormalBounds();
    this.store.setWindow({
      ...bounds,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    });
  }

  private attach(win: BrowserWindow): void {
    const id = win.id;
    const wc = win.webContents;
    const coordinator = new CloseCoordinator({
      isReady: () => handshakeEnabled && this.ready.has(id),
      isAlive: () => !wc.isDestroyed() && !wc.isCrashed(),
      isResponsive: () => !this.unresponsive.has(id),
      askRenderer: () => this.kernel.send(id, 'window:beforeClose', undefined),
      closeNow: () => {
        if (!win.isDestroyed()) win.close();
      },
    });
    this.coordinators.set(id, coordinator);
    this.crashes.set(id, new CrashTracker());

    wc.on('did-start-loading', () => {
      this.ready.delete(id);
      this.pending.pause(id);
    });
    wc.on('did-finish-load', () => this.ready.add(id));
    wc.on('render-process-gone', (_event, details) => {
      this.ready.delete(id);
      this.onGone(win, 'crashed', details.reason as GoneReason);
    });
    win.on('unresponsive', () => {
      this.unresponsive.add(id);
      this.onGone(win, 'unresponsive');
    });
    win.on('responsive', () => this.unresponsive.delete(id));

    const stateChanged = () => {
      this.sendState(win);
      this.remember(win);
    };
    win.on('maximize', stateChanged);
    win.on('unmaximize', stateChanged);
    win.on('enter-full-screen', stateChanged);
    win.on('leave-full-screen', stateChanged);
    win.on('resized', () => this.remember(win));
    win.on('moved', () => this.remember(win));
    win.on('focus', () => {
      this.lastFocused = id;
      this.sendState(win);
      this.kernel.send(id, 'window:focusChanged', { focused: true });
    });
    win.on('blur', () => {
      this.sendState(win);
      if (!win.isDestroyed()) this.kernel.send(id, 'window:focusChanged', { focused: false });
    });

    win.on('close', (event) => {
      if (!this.quitDriven.has(id) && this.quit.isPending) this.quit.onUserInitiatedClose();
      this.remember(win);
      if (!coordinator.onCloseEvent()) event.preventDefault();
    });
    win.on('closed', () => {
      coordinator.dispose();
      this.coordinators.delete(id);
      this.crashes.delete(id);
      this.ready.delete(id);
      this.unresponsive.delete(id);
      this.quitDriven.delete(id);
      this.pending.release(id);
      if (this.lastFocused === id) this.lastFocused = null;
      this.store.flush();
      this.quit.onWindowClosed();
    });
  }

  /** The renderer answered `window:confirmClose`. */
  confirmClose(windowId: number): void {
    this.coordinators.get(windowId)?.confirm();
  }

  /** Ask a window to close, running the safe-close handshake. */
  requestClose(windowId: number): void {
    BrowserWindow.fromId(windowId)?.close();
  }

  private onGone(win: BrowserWindow, kind: RecoveryKind, reason?: GoneReason): void {
    if (reason === 'clean-exit') return;
    const loop = kind === 'crashed' && (this.crashes.get(win.id)?.record(Date.now()) ?? false);
    this.kernel.logger.warn(`Window ${win.id} ${kind}${reason ? ` (${reason})` : ''}`);
    if (hiddenForTests) return;
    void this.recover(win, kind, reason, loop);
  }

  private async recover(
    win: BrowserWindow,
    kind: RecoveryKind,
    reason: GoneReason | undefined,
    crashLoop: boolean,
  ): Promise<void> {
    const dialogSpec = recoveryDialog(kind, { reason, crashLoop });
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: dialogSpec.message,
      detail: dialogSpec.detail,
      buttons: dialogSpec.buttons,
      defaultId: dialogSpec.defaultId,
      cancelId: dialogSpec.cancelId,
      noLink: true,
    });
    if (win.isDestroyed()) return;
    const choice = choiceFor(dialogSpec, response);
    if (choice === 'reload') win.webContents.reload();
    else if (choice === 'close') win.destroy();
  }

  // --- launching ----------------------------------------------------------------------------

  /** Interpret a command line (first launch, second instance, or an OS open request). */
  launch(argv: readonly string[], cwd: string, options: { initial?: boolean } = {}): void {
    const request = parseLaunchArgs(argv, { cwd, appPath: app.getAppPath(), stat });
    if (request.missing.length > 0) {
      this.kernel.logger.info(
        `Ignored launch arguments that do not exist: ${request.missing.length}`,
      );
    }
    this.run(request, options.initial === true);
  }

  private run(request: LaunchRequest, initial: boolean): void {
    const windows = this.liveWindows();
    const restore =
      initial && this.kernel.settings.get(null, 'workbench.restoreSession')
        ? this.kernel.workspaces.getLastOpened()
        : null;
    const context: LaunchContext = {
      windows: windows.map((w) => ({
        id: w.id,
        root: this.kernel.workspaces.getRoot(w.id),
        focused: w.id === this.lastFocused || w.isFocused(),
      })),
      restoreFolder: restore,
      caseInsensitive: this.platform !== 'linux',
    };
    const plan = planLaunch(request, context);

    let last: BrowserWindow | null = null;
    for (const target of plan.targets) {
      let win: BrowserWindow | null =
        target.windowId === null ? null : (BrowserWindow.fromId(target.windowId) ?? null);
      if (!win) {
        win = this.create({ folder: target.folder });
      } else if (target.folder) {
        this.openFolder(win.id, target.folder);
      }
      this.deliver(win.id, target.files);
      last = win;
    }
    const focus =
      plan.focusWindowId === 'last-target'
        ? last
        : plan.focusWindowId === null
          ? null
          : (BrowserWindow.fromId(plan.focusWindowId) ?? null);
    if (focus && !focus.isDestroyed()) {
      if (focus.isMinimized()) focus.restore();
      if (!hiddenForTests) focus.focus();
    }
  }

  private deliver(windowId: number, files: readonly OpenTarget[]): void {
    for (const request of groupOpenRequests(files)) this.offerOpen(windowId, request);
  }

  /** Send now when the renderer is listening, otherwise hold the request until it asks. */
  offerOpen(windowId: number, request: OpenPathsRequest): void {
    if (this.pending.offer(windowId, request)) this.kernel.send(windowId, 'app:openPaths', request);
  }

  consumePendingOpen(windowId: number): OpenPathsRequest[] {
    return this.pending.consume(windowId);
  }

  // --- menus --------------------------------------------------------------------------------

  private menuInput(): MenuInput {
    const features = this.kernel.policy.state.features;
    return {
      commands: COMMANDS,
      platform: this.platform,
      productName: this.kernel.info.name,
      isAvailable: (id) => !(id.startsWith('terminal.') && features.terminal === false),
    };
  }

  private runCommand(window: { id: number } | undefined | null, id: string): void {
    const target =
      (window ? BrowserWindow.fromId(window.id) : null) ??
      BrowserWindow.getFocusedWindow() ??
      this.liveWindows()[0];
    if (target && !target.isDestroyed()) {
      this.kernel.send(target.id, 'command:execute', { id });
    } else if (id === 'file.newWindow') {
      this.create();
    } else if (id === 'file.exit') {
      this.quit.begin();
    }
  }

  private toElectron(items: readonly MenuTemplateItem[]): MenuItemConstructorOptions[] {
    return items.map((item): MenuItemConstructorOptions => {
      if (item.type === 'separator') return { type: 'separator' };
      const entry: MenuItemConstructorOptions = { label: item.label };
      if (item.role) entry.role = ROLE_MAP[item.role];
      if (item.accelerator) {
        entry.accelerator = item.accelerator;
        entry.registerAccelerator = false;
      }
      if (item.commandId) {
        const id = item.commandId;
        entry.click = (_menuItem, window) => this.runCommand(window, id);
      }
      if (item.submenu) entry.submenu = this.toElectron(item.submenu);
      return entry;
    });
  }

  /** Install the application menu. macOS shows it; Windows and Linux draw their own menu bar. */
  installMenu(): void {
    if (this.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate(this.toElectron(buildMenuTemplate(this.menuInput()))),
      );
    } else {
      Menu.setApplicationMenu(null);
    }
  }

  showMenu(windowId: number, name: MenuName, x: number, y: number): void {
    const win = BrowserWindow.fromId(windowId);
    if (!win) return;
    const submenu = buildSubmenu(this.menuInput(), name);
    if (submenu.length === 0) return;
    Menu.buildFromTemplate(this.toElectron(submenu)).popup({
      window: win,
      x: Math.round(x),
      y: Math.round(y),
    });
  }

  // --- theme --------------------------------------------------------------------------------

  applyTheme(windowId: number, scheme: 'light' | 'dark', background: string, foreground: string) {
    nativeTheme.themeSource = scheme;
    const win = BrowserWindow.fromId(windowId);
    if (win && !win.isDestroyed()) {
      win.setBackgroundColor(background);
      if (this.platform !== 'darwin') {
        win.setTitleBarOverlay({ color: background, symbolColor: foreground, height: 36 });
      }
    }
    this.store.setTheme({ scheme, background, foreground });
  }

  /** Set before the process exits so a pending state write is not lost. */
  isQuitting(): boolean {
    return this.quitting;
  }

  flush(): void {
    this.store.flush();
  }
}
