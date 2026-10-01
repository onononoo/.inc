import type { CommandArgs } from '@shared/commands/catalog';
import { describeError } from '@shared/errors';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { useLayoutStore } from '../state/layout-store';
import {
  activateOffset,
  clearTerminal,
  closeTerminal,
  copySelection,
  createTerminal,
  focusTerminal,
  loadProfiles,
  onData,
  onExit,
  onTitle,
  pasteFromClipboard,
  runTask,
  setSessionProfile,
  useTerminals,
} from './terminal-controller';

/** Make sure the panel shows a terminal, starting one when none exists. */
async function ensureTerminal(): Promise<number | null> {
  const state = useTerminals.getState();
  if (state.activeId !== null && state.terminals.some((t) => t.id === state.activeId))
    return state.activeId;
  return createTerminal();
}

function showPanel(): void {
  service('layout').showPanel('terminal', { focus: false });
}

/** Provides the terminal commands and feeds the panel from the main process. */
export function register(): void {
  ipc.on('terminal:data', onData);
  ipc.on('terminal:exit', onExit);
  ipc.on('terminal:title', onTitle);

  const commands = service('commands');
  const contextKeys = service('contextKeys');
  const run = (id: string, handler: (args?: never) => unknown) => commands.register(id, handler);

  // Focus inside a terminal keeps ordinary shortcuts away from the shell (see commands/terminal-keys).
  const syncFocus = () =>
    contextKeys.set('terminalFocus', !!document.activeElement?.closest('.term-host'));
  document.addEventListener('focusin', syncFocus, true);
  document.addEventListener('focusout', () => queueMicrotask(syncFocus), true);

  const active = () => useTerminals.getState().activeId;

  run('terminal.toggle', async () => {
    const layout = useLayoutStore.getState();
    if (layout.panelVisible && layout.panelView === 'terminal') {
      service('layout').togglePanel();
      return;
    }
    showPanel();
    const id = await ensureTerminal();
    if (id !== null) requestAnimationFrame(() => focusTerminal(id));
  });
  run('terminal.new', async () => {
    showPanel();
    const id = await createTerminal();
    if (id !== null) requestAnimationFrame(() => focusTerminal(id));
  });
  run('terminal.kill', async () => {
    const id = active();
    if (id !== null) await closeTerminal(id);
  });
  run('terminal.clear', () => {
    const id = active();
    if (id !== null) clearTerminal(id);
  });
  run('terminal.focus', async () => {
    showPanel();
    const id = await ensureTerminal();
    if (id !== null) requestAnimationFrame(() => focusTerminal(id));
  });
  run('terminal.nextTab', () => activateOffset(1));
  run('terminal.previousTab', () => activateOffset(-1));
  run('terminal.copy', () => {
    const id = active();
    return id !== null ? copySelection(id) : undefined;
  });
  run('terminal.paste', () => {
    const id = active();
    return id !== null ? pasteFromClipboard(id) : undefined;
  });

  // The choice lasts for this session; the setting `terminal.shell` is the saved default.
  run('terminal.selectProfile', async () => {
    try {
      const profiles = await loadProfiles();
      const picked = await service('quickInput').pick(
        profiles.map((p) => ({ id: p.id, label: p.label, description: p.path, icon: 'terminal' })),
        {
          placeholder: 'Select the shell for new terminals',
          title: 'Select default shell',
          activeIds: [
            useTerminals.getState().sessionProfileId ?? profiles.find((p) => p.isDefault)?.id ?? '',
          ],
        },
      );
      if (picked) {
        setSessionProfile(picked.id);
        service('notifications').info(
          `New terminals will use ${picked.label}.`,
          'Set terminal.shell in settings to keep this choice.',
        );
      }
    } catch (error) {
      service('notifications').error('Could not list the shells.', describeError(error));
    }
  });

  run('terminal.runCommand', (async (args?: CommandArgs['terminal.runCommand']) => {
    if (!args?.command) return;
    showPanel();
    const id = await createTerminal({
      initialCommand: args.command,
      name: args.name,
      cwd: args.cwd,
    });
    if (id !== null) requestAnimationFrame(() => focusTerminal(id));
  }) as never);

  run('terminal.runTask', (async (args?: CommandArgs['terminal.runTask']) => {
    let tasks;
    try {
      tasks = await ipc.invoke('tasks:list');
    } catch (error) {
      service('notifications').error('Could not list the tasks.', describeError(error));
      return;
    }
    if (tasks.length === 0) {
      service('notifications').info(
        'No tasks found.',
        'Add scripts to package.json or tasks to .inc/tasks.json.',
      );
      return;
    }
    let task = args?.taskId ? tasks.find((t) => t.id === args.taskId) : undefined;
    if (!task) {
      const picked = await service('quickInput').pick(
        tasks.map((t) => ({
          id: t.id,
          label: t.label,
          description: t.source === 'npm' ? 'package.json' : '.inc/tasks.json',
          detail: t.command,
          icon: 'play',
        })),
        { placeholder: 'Select a task to run', title: 'Run task' },
      );
      task = tasks.find((t) => t.id === picked?.id);
    }
    if (!task) return;
    showPanel();
    await runTask(task);
    const id = active();
    if (id !== null) requestAnimationFrame(() => focusTerminal(id));
  }) as never);
}
