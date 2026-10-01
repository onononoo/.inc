import { describeError } from '@shared/errors';
import type { CommandArgs } from '@shared/commands/catalog';
import type { OpenPathsRequest } from '@shared/api/app';
import { hasService, provide, service } from '../services/registry';
import { ipc } from '../services/ipc';
import { flushSession } from '../services/session';
import { hydrateLayout, useLayoutStore } from '../state/layout-store';
import { createNotificationService } from '../state/notification-store';
import { initPolicy, usePolicyStore } from '../state/policy-store';
import { setSetting, getSetting } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { Button } from '../ui/Button';
import { copyText } from '../ui/clipboard';
import { installInputModality } from '../ui/input-modality';
import {
  createDialogService,
  createLayoutService,
  createMenuService,
  createStatusBarService,
} from './services';
import { startupRequests } from './startup';
import { startThemeSync, startZoomSync } from './theme';
import { startTitleSync } from './title';

const ZOOM_STEP = 0.5;
const ZOOM_MIN = -3;
const ZOOM_MAX = 5;

const notifications = () => service('notifications');

async function openFolder(path: string): Promise<void> {
  if (hasService('editor') && !(await service('editor').confirmCloseWindow())) return;
  await ipc.invoke('workspace:open', path);
}

async function chooseFolder(args?: CommandArgs['file.openFolder']): Promise<void> {
  const path = args?.path ?? (await ipc.invoke('dialog:openFolder', { title: 'Open folder' }));
  if (path) await openFolder(path);
}

async function chooseFiles(args?: CommandArgs['file.openFile']): Promise<void> {
  const paths = args?.path
    ? [args.path]
    : await ipc.invoke('dialog:openFiles', { title: 'Open file' });
  for (const path of paths) {
    await service('commands').execute('editor.openFile', { path });
  }
}

async function openRecent(): Promise<void> {
  const recent = await ipc.invoke('workspace:getRecent');
  if (recent.length === 0) {
    notifications().info('No recent folders.', 'Folders you open appear here.');
    return;
  }
  const picked = await service('quickInput').pick(
    recent.map((r) => ({ id: r.path, label: r.name, description: r.path, icon: 'folder' })),
    { placeholder: 'Select a folder to open', title: 'Open recent' },
  );
  if (picked) await openFolder(picked.id);
}

function zoomBy(delta: number | 'reset'): Promise<void> {
  const current = getSetting('appearance.zoomLevel');
  const next = delta === 'reset' ? 0 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current + delta));
  return setSetting('appearance.zoomLevel', next);
}

function showAbout(): void {
  void ipc.invoke('app:getInfo').then((info) => {
    const policy = usePolicyStore.getState().policy;
    service('dialogs').showCustom(
      (close) => (
        <div className="about">
          <p className="about-name">
            <span className="about-dot" aria-hidden="true" />
            {info.name}
          </p>
          <dl className="about-list">
            <dt>Version</dt>
            <dd>{info.version}</dd>
            <dt>Electron</dt>
            <dd>{info.electron}</dd>
            <dt>Chromium</dt>
            <dd>{info.chrome}</dd>
            <dt>Node.js</dt>
            <dd>{info.node}</dd>
            <dt>Platform</dt>
            <dd>
              {info.platform} {info.arch}
            </dd>
          </dl>
          <p>This build contains no telemetry and makes no network requests.</p>
          {policy.active && (
            <p>{policy.notice ?? 'This installation is managed by your organization.'}</p>
          )}
          <div className="ui-dialog-actions">
            <Button
              onClick={() => {
                void service('commands').execute('help.copyDiagnostics');
              }}
            >
              Copy diagnostics
            </Button>
            <Button variant="primary" data-autofocus onClick={close}>
              Close
            </Button>
          </div>
        </div>
      ),
      { title: `About ${info.name}`, width: 440 },
    );
  });
}

/** An open request from the command line or the operating system. */
async function handleOpenRequest(request: OpenPathsRequest): Promise<void> {
  for (const path of request.paths) {
    try {
      const info = await ipc.invoke('fs:stat', path);
      if (info.kind === 'directory') {
        await openFolder(path);
      } else {
        await service('commands').execute('editor.openFile', {
          path,
          line: request.line,
          column: request.column,
        });
      }
    } catch (error) {
      notifications().error(`Could not open ${path}.`, describeError(error));
    }
  }
}

function registerStatusItems(): void {
  const statusBar = service('statusBar');
  const restricted = statusBar.register({
    id: 'restricted',
    side: 'left',
    priority: 1000,
    icon: 'shield-alert',
    text: 'Restricted Mode',
    tooltip: 'This folder is not trusted. Click to manage trust.',
    command: 'settings.manageTrust',
    visible: false,
  });
  const managed = statusBar.register({
    id: 'managed',
    side: 'right',
    priority: 1000,
    icon: 'shield',
    text: 'Managed',
    tooltip: 'Some settings are managed by your organization.',
    command: 'settings.showPolicy',
    visible: false,
  });
  const syncRestricted = () => {
    const workspace = useWorkspaceStore.getState().workspace;
    restricted.update({ visible: workspace !== null && workspace.trust === 'untrusted' });
  };
  syncRestricted();
  useWorkspaceStore.subscribe(syncRestricted);
  const syncManaged = () => {
    const policy = usePolicyStore.getState().policy;
    managed.update({
      visible: policy.active,
      tooltip: policy.notice ?? 'Some settings are managed by your organization.',
    });
  };
  syncManaged();
  usePolicyStore.subscribe(syncManaged);
}

/** Provides the workbench services and registers the commands that belong to the window itself. */
export function register(): void {
  provide('notifications', createNotificationService());
  provide('dialogs', createDialogService());
  provide('menus', createMenuService());
  provide('statusBar', createStatusBarService());
  provide('layout', createLayoutService());

  hydrateLayout();
  installInputModality();
  startThemeSync();
  startZoomSync();
  startTitleSync();
  void initPolicy();
  registerStatusItems();

  const contextKeys = service('contextKeys');
  const syncLayoutKeys = () => {
    const state = useLayoutStore.getState();
    contextKeys.set('sidebarVisible', state.sidebarVisible);
    contextKeys.set('panelVisible', state.panelVisible);
    contextKeys.set('activeSidebar', state.sidebarView);
    contextKeys.set('activePanel', state.panelView);
  };
  syncLayoutKeys();
  useLayoutStore.subscribe(syncLayoutKeys);

  const commands = service('commands');
  const layout = service('layout');
  const run = (id: string, handler: (args?: never) => unknown) => commands.register(id, handler);

  // View ---------------------------------------------------------------------------------------
  run('view.showExplorer', () => layout.showSidebar('explorer', { focus: true }));
  run('view.showSearch', () => layout.showSidebar('search', { focus: true }));
  run('view.showGit', () => layout.showSidebar('git', { focus: true }));
  run('view.showProblems', () => layout.showPanel('problems', { focus: true }));
  run('view.showSidebar', ((args?: CommandArgs['view.showSidebar']) =>
    layout.showSidebar(args?.view ?? 'explorer', { focus: true })) as never);
  run('view.toggleSidebar', () => layout.toggleSidebar());
  run('view.toggleBottomPanel', () => layout.togglePanel());
  run('view.toggleFullscreen', () => ipc.invoke('window:control', 'toggleFullscreen'));
  run('view.zoomIn', () => zoomBy(ZOOM_STEP));
  run('view.zoomOut', () => zoomBy(-ZOOM_STEP));
  run('view.zoomReset', () => zoomBy('reset'));
  run('view.reload', async () => {
    await flushSession();
    await ipc.invoke('window:reload');
  });

  // File ---------------------------------------------------------------------------------------
  run('file.openFolder', chooseFolder as never);
  run('file.openFile', chooseFiles as never);
  run('file.openRecent', openRecent);
  run('file.closeFolder', async () => {
    if (hasService('editor') && !(await service('editor').confirmCloseWindow())) return;
    await ipc.invoke('workspace:close');
  });
  run('file.newWindow', () => ipc.invoke('window:new'));
  run('file.closeWindow', () => ipc.invoke('window:control', 'close'));
  run('file.exit', () => ipc.invoke('app:quit'));

  // Help ---------------------------------------------------------------------------------------
  run('help.about', showAbout);
  run('help.shortcuts', () => commands.execute('settings.openKeybindings'));
  run('help.thirdPartyNotices', async () => {
    const path = await ipc.invoke('app:getNoticesPath');
    if (path) await service('editor').openFile(path);
    else service('notifications').info('The third-party notices file is not part of this build.');
  });
  run('help.showLogs', () => ipc.invoke('app:showLogs'));
  run('help.toggleDevTools', () => ipc.invoke('window:toggleDevTools'));
  run('help.copyDiagnostics', async () => {
    const report = await ipc.invoke('app:getDiagnostics');
    if (await copyText(report))
      notifications().info('Diagnostics copied.', 'Paste them into a support request.');
    else
      notifications().error(
        'Could not copy the diagnostics.',
        'Allow clipboard access and try again.',
      );
  });

  // Events from the main process ---------------------------------------------------------------
  ipc.on('command:execute', ({ id, args }) => void commands.execute(id, args));
  ipc.on('app:openPaths', (request) => void handleOpenRequest(request));
  ipc.on('window:beforeClose', () => {
    void (async () => {
      const safe = hasService('editor') ? await service('editor').confirmCloseWindow() : true;
      if (!safe) return;
      await flushSession();
      await ipc.invoke('window:confirmClose');
    })();
  });
  // Requests that arrived before this window was listening (command line, OS open).
  void ipc
    .invoke('app:consumePendingOpen')
    .then(async (pending) => {
      for (const request of pending) await handleOpenRequest(request);
      startupRequests.done(pending.length);
    })
    .catch(() => startupRequests.done(0));
}
