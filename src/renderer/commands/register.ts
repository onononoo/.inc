import { COMMANDS } from '@shared/commands/catalog';
import type { CommandArgs } from '@shared/commands/catalog';
import type { Unsubscribe } from '../contracts/commands';
import type {
  InputBoxOptions,
  QuickInputService,
  QuickPickItem,
  QuickPickOptions,
} from '../contracts/commands';
import { hasService, provide, service } from '../services/registry';
import { ipc, platform } from '../services/ipc';
import { useWorkspaceStore } from '../state/workspace-store';
import { createCommandService } from './command-service';
import { createContextKeyService } from './context-keys';
import { chordHint, quickInput } from './instance';
import { createKeybindingService, type KeyEventTarget } from './keybinding-service';
import { createPalette } from './palette';
import { filterPickItems } from './pick-filter';
import type { QuickItem } from './quick-input-controller';
import { createRecentCommands } from './recent';

const NO_MATCH = 'No matching items';

/** True for a text field that is not a Monaco editor's hidden input (Monaco has its own keys). */
function isPlainTextField(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest('.monaco-editor')) return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
      element.type,
    );
  }
  return element.isContentEditable;
}

function createQuickInputService(openPalette: (prefix: string) => void): QuickInputService {
  return {
    pick<T = unknown>(
      items:
        QuickPickItem<T>[] | ((query: string) => QuickPickItem<T>[] | Promise<QuickPickItem<T>[]>),
      options: QuickPickOptions = {},
    ): Promise<QuickPickItem<T> | undefined> {
      return new Promise((resolve) => {
        let chosen = false;
        const filter = options.filter !== false;
        quickInput.open({
          kind: 'pick',
          title: options.title,
          placeholder: options.placeholder ?? 'Select an item',
          ariaLabel: options.title ?? options.placeholder ?? 'Select an item',
          initialValue: options.initialValue ?? '',
          emptyText: NO_MATCH,
          currentIds: options.activeIds,
          onActive: options.onActiveChange ? (item) => options.onActiveChange?.(item) : undefined,
          async query(value) {
            const list = typeof items === 'function' ? await items(value) : items;
            const shown =
              filter && typeof items !== 'function'
                ? filterPickItems(list as QuickItem[], value)
                : (list as QuickItem[]);
            return { items: shown, emptyText: NO_MATCH };
          },
          accept(item) {
            chosen = true;
            resolve(item as QuickPickItem<T> | undefined);
          },
          cancel() {
            if (!chosen) resolve(undefined);
          },
        });
      });
    },

    input(options: InputBoxOptions): Promise<string | undefined> {
      return new Promise((resolve) => {
        let done = false;
        quickInput.open({
          kind: 'input',
          title: options.title,
          placeholder: options.placeholder ?? '',
          ariaLabel: options.title ?? options.prompt ?? options.placeholder ?? 'Input',
          initialValue: options.value ?? '',
          emptyText: '',
          prompt: options.prompt,
          password: options.password,
          validate: options.validate ? (value) => options.validate?.(value) : undefined,
          accept(_item, value) {
            done = true;
            resolve(value);
          },
          cancel() {
            if (!done) resolve(undefined);
          },
        });
      });
    },

    showCommandPalette: () => openPalette('>'),
    showQuickOpen: (initial = '') => openPalette(initial),
  };
}

/** Provides the command bus, context keys, keybindings and quick input; registers the palette commands. */
export function register(): void {
  const contextKeys = createContextKeyService();
  provide('contextKeys', contextKeys);

  const commands = createCommandService({
    contextKeys,
    notify: (level, message, detail) => {
      if (!hasService('notifications')) return;
      const notifications = service('notifications');
      if (level === 'error') notifications.error(message, detail);
      else notifications.info(message, detail);
    },
    log: (level, message) => void ipc.invoke('app:log', level, message).catch(() => undefined),
  });
  provide('commands', commands);

  // --- context keys this slice owns ---------------------------------------------------------
  contextKeys.set('isMac', platform === 'darwin');
  contextKeys.set('isWindows', platform === 'win32');
  contextKeys.set('isLinux', platform === 'linux');
  contextKeys.set('inputFocus', false);
  contextKeys.set('quickInputVisible', false);

  const syncWorkspace = () => {
    const { workspace } = useWorkspaceStore.getState();
    contextKeys.set('hasWorkspace', workspace !== null);
    contextKeys.set('workspaceTrusted', workspace !== null && workspace.trust === 'trusted');
  };
  syncWorkspace();
  useWorkspaceStore.subscribe(syncWorkspace);

  const syncPolicy = (active: boolean) => contextKeys.set('isManaged', active);
  syncPolicy(false);
  void ipc
    .invoke('policy:get')
    .then((state) => syncPolicy(state.active))
    .catch(() => undefined);
  ipc.on('policy:changed', (state) => syncPolicy(state.active));

  const syncInputFocus = () =>
    contextKeys.set('inputFocus', isPlainTextField(document.activeElement));
  document.addEventListener('focusin', syncInputFocus, true);
  document.addEventListener('focusout', () => queueMicrotask(syncInputFocus), true);

  quickInput.configure({
    captureFocus: () => {
      const previous = document.activeElement;
      return previous instanceof HTMLElement
        ? () => previous.focus({ preventScroll: true })
        : undefined;
    },
    onVisibleChange: (visible) => contextKeys.set('quickInputVisible', visible),
    reportError: (error) => {
      if (hasService('notifications')) {
        service('notifications').error(
          'Could not complete the action.',
          error instanceof Error ? error.message : undefined,
        );
      }
    },
  });

  // --- keybindings --------------------------------------------------------------------------
  const keybindings = createKeybindingService({
    platform,
    contexts: contextKeys,
    commands,
    loadOverrides: async () => (await ipc.invoke('keybindings:get')).entries,
    onOverridesChanged: (cb): Unsubscribe =>
      ipc.on('keybindings:changed', (snapshot) => cb(snapshot.entries)),
    target: window as unknown as KeyEventTarget,
    onHint: (text) => chordHint.set(text),
    isEditorTarget: (target) =>
      target instanceof Element && target.closest('.monaco-editor') !== null,
    replayKey: (target, key) => {
      if (target instanceof EventTarget) {
        target.dispatchEvent(
          new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }),
        );
      }
    },
  });
  provide('keybindings', keybindings);
  keybindings.start();

  // --- palette and quick open ---------------------------------------------------------------
  const recent = createRecentCommands();
  const palette = createPalette(
    {
      platform,
      catalog: COMMANDS,
      commands: {
        execute: ((id: string, args?: unknown) => {
          recent.record(id);
          return commands.execute(id, args);
        }) as typeof commands.execute,
        isEnabled: (id) => commands.isEnabled(id),
      },
      keybindings,
      recent,
      workspaceRoot: () => useWorkspaceStore.getState().workspace?.root ?? null,
      openPaths: () => (hasService('editor') ? service('editor').getOpenPaths() : []),
      searchFiles: (query, limit) => ipc.invoke('files:search', query, limit),
      isFile: async (path) => {
        try {
          return (await ipc.invoke('fs:stat', path)).kind === 'file';
        } catch {
          return false;
        }
      },
      editorLineInfo: () => {
        if (!hasService('editorHost')) return null;
        const editor = service('editorHost').getActiveEditor();
        const model = editor?.getModel();
        const position = editor?.getPosition();
        if (!editor || !model || !position) return null;
        return {
          lineCount: model.getLineCount(),
          line: position.lineNumber,
          column: position.column,
          maxColumn: (line) =>
            model.getLineMaxColumn(Math.min(Math.max(line, 1), model.getLineCount())),
        };
      },
      goToLine: (line, column) => {
        const editor = hasService('editorHost') ? service('editorHost').getActiveEditor() : null;
        if (!editor) return;
        editor.setPosition({ lineNumber: line, column });
        editor.revealPositionInCenterIfOutsideViewport({ lineNumber: line, column });
        editor.focus();
      },
      onIndexProgress: (listener) => ipc.on('files:indexProgress', listener),
    },
    quickInput,
  );
  provide(
    'quickInput',
    createQuickInputService((prefix) => palette.show(prefix)),
  );

  commands.register('palette.commands', () => palette.show('>'));
  commands.register('palette.show', ((args?: CommandArgs['palette.show']) =>
    palette.show(args?.prefix ?? '>')) as never);
  commands.register('palette.quickOpen', () => palette.show(''));
  commands.register('palette.gotoLine', () => palette.show(':'));
  commands.register('palette.gotoSymbol', async () => {
    const editor = hasService('editorHost') ? service('editorHost').getActiveEditor() : null;
    await editor?.getAction('editor.action.quickOutline')?.run();
  });
}
