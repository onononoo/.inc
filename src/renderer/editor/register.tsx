import type { editor as MonacoEditor } from 'monaco-editor';
import { ENCODINGS, type TextEncoding } from '@shared/encodings';
import type { CommandArgs } from '@shared/commands/catalog';
import { relativeTo } from '@shared/paths';
import type { CustomEditorInput } from '../contracts/editor';
import { monaco, setupMonaco } from '../monaco';
import { ipc, platform } from '../services/ipc';
import { provide, service } from '../services/registry';
import { getSection, loadSession, resetSession, setSection } from '../services/session';
import { hydrateLayout } from '../state/layout-store';
import { useProblemCounts } from '../state/problems-store';
import { getSetting, setSetting } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { Icon } from '../ui/Icon';
import { copyText } from '../ui/clipboard';
import { startupRequests } from '../workbench/startup';
import { setActiveFileTitle } from '../workbench/title';
import { DocumentsService } from './documents';
import { readDocumentSettings } from './document-policy';
import { documentsStore } from './documents-store';
import { editorHost } from './editor-host';
import { registerCustomComponent } from './editor-requests';
import { EditorServiceImpl } from './editor-service';
import { activeGroup, activeTab, openTab } from './groups-model';
import { groupsStore, updateGroups } from './groups-store';
import { createMonacoPort } from './monaco-port';
import { NavigationHistory } from './nav-history';
import { buildProblemSet, publishProblems, type RawMarker } from './problems';
import { setEditorRuntime } from './runtime';
import { useEditorStatus } from './status-store';
import { Welcome } from './Welcome';

interface SavedTab {
  kind: 'file' | 'custom';
  path?: string;
  input?: CustomEditorInput;
  preview?: boolean;
  pinned?: boolean;
}

interface SavedView {
  line: number;
  column: number;
  scrollTop: number;
  scrollLeft: number;
}

interface EditorSession {
  version: 1;
  groups: { tabs: SavedTab[]; active: number }[];
  activeGroup: number;
  views: Record<string, SavedView>;
}

const MAX_RESTORED_TABS = 30;
/** Custom tabs that make sense to bring back after a restart. */
const RESTORABLE_CUSTOM = new Set(['settings', 'keybindings']);

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

function runAction(id: string): void {
  const editor = editorHost.getActiveEditor();
  void editor?.getAction(id)?.run();
}

function activeEditor(): MonacoEditor.IStandaloneCodeEditor | null {
  return editorHost.getActiveEditor();
}

/** Provides the editor and editor host services and every editor and document command. */
export function register(): void {
  setupMonaco();

  const monacoPort = createMonacoPort();
  const navigation = new NavigationHistory();

  const documents = new DocumentsService({
    ipc,
    monaco: monacoPort,
    platform: platform as never,
    settings: () => readDocumentSettings(getSetting),
    workspaceRoot: () => useWorkspaceStore.getState().workspace?.root ?? null,
    ui: () => ({
      choose: (o) => service('dialogs').choose(o),
      confirm: (o) => service('dialogs').confirm(o),
      notify: (o) => service('notifications').notify(o),
    }),
    compare: (input) => editorService.openDiff(input),
    log: (level, message) => void ipc.invoke('app:log', level, message).catch(() => undefined),
    baseRulers: () => getSetting('editor.rulers'),
    format: async (doc) => {
      const editor = editorHost.all().find((e) => e.getModel() === doc.model);
      await editor?.getAction('editor.action.formatDocument')?.run();
    },
  });

  const editorService: EditorServiceImpl = new EditorServiceImpl({
    documents,
    choose: (o) => service('dialogs').choose(o),
    notifications: () => service('notifications'),
    previewEnabled: () => getSetting('workbench.previewEditors'),
    navigation,
    hash,
  });
  setEditorRuntime({ documents, service: editorService, navigation });
  provide('editor', editorService);
  provide('editorHost', editorHost);
  registerCustomComponent('welcome', Welcome);

  const contextKeys = service('contextKeys');
  const commands = service('commands');
  const run = (id: string, handler: (args?: never) => unknown) => commands.register(id, handler);

  // --- keeping the rest of the window informed ----------------------------------------------

  const syncGroupsKeys = () => {
    const group = activeGroup(groupsStore.getState());
    const tab = activeTab(group);
    contextKeys.set('hasActiveEditor', tab?.input.kind === 'file' || tab?.input.kind === 'diff');
    const doc = editorService.activeDocument();
    setActiveFileTitle(doc ? { name: doc.name, dirty: doc.isDirty() } : null);
  };
  const syncDocumentKeys = () => {
    const dirty = documentsStore.getState().dirtyCount;
    contextKeys.set('hasDirtyEditors', dirty > 0);
    void ipc.invoke('window:setDocumentEdited', dirty > 0).catch(() => undefined);
    syncGroupsKeys();
  };
  groupsStore.subscribe(syncGroupsKeys);
  documentsStore.subscribe(syncDocumentKeys);
  syncGroupsKeys();
  syncDocumentKeys();

  ipc.on('fs:changed', (changes) => void documents.applyFsChanges(changes));
  ipc.on('window:focusChanged', ({ focused }) => {
    if (!focused && getSetting('files.autoSave') === 'onWindowChange')
      void documents.saveDirtyFiles();
  });

  // --- problems -----------------------------------------------------------------------------

  let problemTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshProblems = () => {
    const markers: RawMarker[] = monaco.editor
      .getModelMarkers({})
      .filter((m) => m.resource.scheme === 'file' || m.resource.scheme === 'untitled')
      .map((m) => ({
        path: m.resource.scheme === 'file' ? m.resource.fsPath : m.resource.path,
        severity: m.severity,
        message: m.message,
        source: m.source,
        code: typeof m.code === 'object' ? m.code?.value : m.code,
        startLineNumber: m.startLineNumber,
        startColumn: m.startColumn,
        endLineNumber: m.endLineNumber,
        endColumn: m.endColumn,
      }));
    publishProblems(buildProblemSet(markers));
  };
  monaco.editor.onDidChangeMarkers(() => {
    clearTimeout(problemTimer);
    problemTimer = setTimeout(refreshProblems, 120);
  });

  // --- status bar ---------------------------------------------------------------------------

  const statusBar = service('statusBar');
  const items = {
    problems: statusBar.register({
      id: 'problems',
      side: 'left',
      priority: 100,
      text: '',
      command: 'view.showProblems',
      tooltip: 'Show problems',
    }),
    cursor: statusBar.register({
      id: 'cursor',
      side: 'right',
      priority: 10,
      text: '',
      command: 'palette.gotoLine',
      tooltip: 'Go to line',
      visible: false,
    }),
    indent: statusBar.register({
      id: 'indent',
      side: 'right',
      priority: 20,
      text: '',
      command: 'editor.changeIndentation',
      tooltip: 'Change indentation',
      visible: false,
    }),
    encoding: statusBar.register({
      id: 'encoding',
      side: 'right',
      priority: 30,
      text: '',
      command: 'editor.changeEncoding',
      tooltip: 'Change encoding',
      visible: false,
    }),
    eol: statusBar.register({
      id: 'eol',
      side: 'right',
      priority: 40,
      text: '',
      command: 'editor.changeEol',
      tooltip: 'Change line ending',
      visible: false,
    }),
    language: statusBar.register({
      id: 'language',
      side: 'right',
      priority: 50,
      text: '',
      command: 'editor.changeLanguage',
      tooltip: 'Change language',
      visible: false,
    }),
  };
  const encodingLabel = (id: TextEncoding) => ENCODINGS.find((e) => e.id === id)?.label ?? id;
  const syncProblemsItem = () => {
    const { errors, warnings } = useProblemCounts.getState();
    items.problems.update({
      text: (
        <span className="wb-status-problems">
          <Icon name="x-circle" size={14} className={errors > 0 ? 'is-error' : undefined} />{' '}
          {errors}
          <Icon
            name="alert-triangle"
            size={14}
            className={warnings > 0 ? 'is-warning' : undefined}
          />{' '}
          {warnings}
        </span>
      ),
      tooltip: `${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`,
    });
  };
  useProblemCounts.subscribe(syncProblemsItem);
  syncProblemsItem();
  const syncStatusItems = () => {
    const status = useEditorStatus.getState().status;
    const visible = status !== null;
    for (const key of ['cursor', 'indent', 'encoding', 'eol', 'language'] as const)
      items[key].update({ visible });
    if (!status) return;
    const selection =
      status.selectedChars > 0 ? ` (${status.selectedChars.toLocaleString('en-US')} selected)` : '';
    items.cursor.update({
      text: `Ln ${status.line.toLocaleString('en-US')}, Col ${status.column}${selection}`,
    });
    items.indent.update({
      text: status.insertSpaces ? `Spaces: ${status.tabSize}` : `Tab size: ${status.tabSize}`,
    });
    items.encoding.update({ text: encodingLabel(status.encoding) });
    items.eol.update({ text: status.eol === 'crlf' ? 'CRLF' : 'LF' });
    items.language.update({ text: status.languageName });
  };
  useEditorStatus.subscribe(syncStatusItems);
  syncStatusItems();

  // --- session ------------------------------------------------------------------------------

  const views = new Map<string, SavedView>();
  const captureViews = () => {
    for (const editor of editorHost.all()) {
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) continue;
      // Key by the document's own path: a model URI spells Windows drive letters differently.
      const path = documents.all().find((d) => d.model === model)?.path;
      if (!path) continue;
      views.set(path, {
        line: position.lineNumber,
        column: position.column,
        scrollTop: editor.getScrollTop(),
        scrollLeft: editor.getScrollLeft(),
      });
    }
  };
  const serialize = (): EditorSession => {
    captureViews();
    const state = groupsStore.getState();
    const saved: EditorSession['groups'] = state.groups.map((group) => {
      const tabs: SavedTab[] = [];
      let active = 0;
      for (const tab of group.tabs) {
        let entry: SavedTab | null = null;
        if (tab.input.kind === 'file') {
          const doc = documents.get(tab.input.key);
          if (doc?.path)
            entry = { kind: 'file', path: doc.path, preview: tab.preview, pinned: tab.pinned };
        } else if (tab.input.kind === 'custom' && RESTORABLE_CUSTOM.has(tab.input.input.kind)) {
          entry = { kind: 'custom', input: tab.input.input, pinned: tab.pinned };
        }
        if (!entry) continue;
        if (tab.id === group.activeTabId) active = tabs.length;
        tabs.push(entry);
      }
      return { tabs, active };
    });
    const paths = new Set(documents.openPaths());
    const kept: Record<string, SavedView> = {};
    for (const [path, view] of views) if (paths.has(path)) kept[path] = view;
    return {
      version: 1,
      groups: saved,
      activeGroup: Math.max(
        0,
        state.groups.findIndex((g) => g.id === state.activeGroupId),
      ),
      views: kept,
    };
  };
  const persist = () => setSection('editor', serialize());
  groupsStore.subscribe(persist);
  // Moving the cursor does not change the groups, so write the view shortly after it settles.
  let viewTimer: ReturnType<typeof setTimeout> | undefined;
  useEditorStatus.subscribe(() => {
    clearTimeout(viewTimer);
    viewTimer = setTimeout(persist, 400);
  });
  window.addEventListener('pagehide', persist);

  const restore = async (): Promise<boolean> => {
    const saved = getSection<EditorSession>('editor');
    if (!saved || saved.version !== 1 || !Array.isArray(saved.groups)) return false;
    let restored = 0;
    for (const [groupIndex, group] of saved.groups.slice(0, 2).entries()) {
      if (groupIndex === 1 && groupsStore.getState().groups.length < 2) {
        const anchor = groupsStore.getState();
        updateGroups((s) => ({
          ...s,
          groups: [...s.groups, { id: anchor.nextGroupId, tabs: [], activeTabId: null, mru: [] }],
          nextGroupId: s.nextGroupId + 1,
        }));
      }
      const target = groupsStore.getState().groups[groupIndex];
      if (!target) continue;
      let activeId: string | null = null;
      for (const [tabIndex, tab] of group.tabs.slice(0, MAX_RESTORED_TABS).entries()) {
        if (tab.kind === 'file' && tab.path) {
          try {
            await ipc.invoke('fs:stat', tab.path);
            const doc = await documents.open(tab.path);
            const view = saved.views?.[tab.path];
            if (view) doc.initialView = view;
            updateGroups((s) =>
              openTab(
                s,
                { kind: 'file', key: doc.key },
                { groupId: target.id, activate: false, preview: tab.preview === true },
              ),
            );
            restored++;
            if (tabIndex === group.active) activeId = `file:${doc.key}`;
          } catch {
            /* the file is gone or unreadable: leave it out */
          }
        } else if (tab.kind === 'custom' && tab.input) {
          const input = tab.input;
          updateGroups((s) =>
            openTab(
              s,
              { kind: 'custom', key: input.key, input },
              { groupId: target.id, activate: false },
            ),
          );
          restored++;
          if (tabIndex === group.active) activeId = `custom:${input.key}`;
        }
      }
      if (activeId) {
        const id = activeId;
        updateGroups((s) => ({
          ...s,
          groups: s.groups.map((g) =>
            g.id === target.id && g.tabs.some((t) => t.id === id)
              ? { ...g, activeTabId: id, mru: [id, ...g.mru.filter((x) => x !== id)] }
              : g,
          ),
        }));
      }
    }
    const groups = groupsStore.getState().groups;
    const activeIndex = Math.min(Math.max(saved.activeGroup ?? 0, 0), groups.length - 1);
    const group = groups[activeIndex];
    if (group) updateGroups((s) => ({ ...s, activeGroupId: group.id }));
    return restored > 0;
  };

  const openStartup = async () => {
    const restoredTabs = getSetting('workbench.restoreSession') ? await restore() : false;
    const requested = await startupRequests.promise;
    if (!restoredTabs && requested === 0 && getSetting('workbench.startupEditor') === 'welcome') {
      editorService.openCustom({
        kind: 'welcome',
        key: 'welcome',
        title: 'Welcome',
        icon: 'files',
      });
    }
  };

  // A different folder means a different session: close everything, load that session, restore.
  let currentRoot = useWorkspaceStore.getState().workspace?.root ?? null;
  useWorkspaceStore.subscribe(async (state) => {
    const next = state.workspace?.root ?? null;
    if (next === currentRoot) return;
    currentRoot = next;
    editorService.discardAll();
    views.clear();
    resetSession();
    await loadSession();
    hydrateLayout();
    await openStartup();
  });

  // --- commands: files ----------------------------------------------------------------------

  const doc = () => editorService.activeDocument();
  run('editor.openFile', ((args?: CommandArgs['editor.openFile']) => {
    if (!args?.path) return undefined;
    return editorService.openFile(args.path, args);
  }) as never);
  run('file.newFile', () => editorService.newUntitled());
  run('file.save', () => editorService.save());
  run('file.saveAs', () => {
    const d = doc();
    return d ? documents.saveAs(d) : undefined;
  });
  run('file.saveAll', () => editorService.saveAll());
  run('file.revert', async () => {
    const d = doc();
    if (!d || !d.isDirty()) return;
    const ok = await service('dialogs').confirm({
      title: `Revert ${d.name}?`,
      message: 'Your unsaved changes will be discarded.',
      confirmLabel: 'Revert',
      danger: true,
    });
    if (ok) await documents.revert(d);
  });
  run('file.closeEditor', () => editorService.closeActiveTab());
  run('file.closeAllEditors', () => editorService.closeAllEditors());

  // --- commands: tabs and groups ------------------------------------------------------------

  run('editor.nextTab', () => editorService.step(1));
  run('editor.previousTab', () => editorService.step(-1));
  run('editor.nextRecentTab', () => editorService.stepRecent(1));
  run('editor.previousRecentTab', () => editorService.stepRecent(-1));
  run('editor.reopenClosed', () => editorService.reopenClosed());
  run('editor.closeOthers', () => {
    const group = activeGroup(groupsStore.getState());
    return group.activeTabId ? editorService.closeOthers(group.id, group.activeTabId) : undefined;
  });
  run('editor.closeSaved', () => editorService.closeSaved(activeGroup(groupsStore.getState()).id));
  run('editor.pinTab', () => {
    const group = activeGroup(groupsStore.getState());
    const tab = activeTab(group);
    if (tab) editorService.pin(group.id, tab.id, !tab.pinned);
  });
  run('editor.splitRight', () => editorService.split());
  run('editor.closeGroup', () =>
    editorService.closeEditorGroup(groupsStore.getState().activeGroupId),
  );
  run('editor.focusFirstGroup', () => editorService.focusGroup(0));
  run('editor.focusSecondGroup', () => editorService.focusGroup(1));
  run('editor.moveToOtherGroup', () => editorService.moveToOtherGroup());

  // --- commands: document properties --------------------------------------------------------

  run('editor.toggleWordWrap', () =>
    setSetting('editor.wordWrap', getSetting('editor.wordWrap') === 'off' ? 'on' : 'off'),
  );
  run('editor.toggleMinimap', () => setSetting('editor.minimap', !getSetting('editor.minimap')));
  run('editor.copyPath', async () => {
    const path = doc()?.path;
    if (path) await copyText(path);
  });
  run('editor.copyRelativePath', async () => {
    const path = doc()?.path;
    const root = useWorkspaceStore.getState().workspace?.root;
    if (!path) return;
    await copyText((root ? relativeTo(root, path, platform as never) : null) ?? path);
  });
  run('editor.revealInExplorer', () => {
    const path = doc()?.path;
    if (path) return commands.execute('explorer.reveal', { path });
    return undefined;
  });
  run('editor.revealInOS', () => {
    const path = doc()?.path;
    if (path) return ipc.invoke('fs:reveal', path);
    return undefined;
  });

  run('editor.changeLanguage', async () => {
    const d = doc();
    if (!d) return;
    const picked = await service('quickInput').pick(
      monacoPort.languageChoices().map((l) => ({ id: l.id, label: l.name, description: l.id })),
      { placeholder: 'Select a language', title: 'Change language', activeIds: [d.languageId] },
    );
    if (picked) documents.setLanguage(d, picked.id);
  });
  run('editor.changeEol', async () => {
    const d = doc();
    if (!d) return;
    const picked = await service('quickInput').pick(
      [
        { id: 'lf', label: 'LF', description: 'Unix, macOS' },
        { id: 'crlf', label: 'CRLF', description: 'Windows' },
      ],
      { placeholder: 'Select the line ending', title: 'Change line ending', activeIds: [d.eol] },
    );
    if (picked) documents.setEol(d, picked.id as 'lf' | 'crlf');
  });
  const pickEncoding = (title: string) =>
    service('quickInput').pick(
      ENCODINGS.map((e) => ({ id: e.id, label: e.label })),
      { placeholder: 'Select an encoding', title, activeIds: doc() ? [doc()!.encoding] : [] },
    );
  run('editor.changeEncoding', async () => {
    const d = doc();
    if (!d) return;
    const picked = await pickEncoding('Save with encoding');
    if (picked) documents.setSaveEncoding(d, picked.id as TextEncoding);
  });
  run('editor.reopenWithEncoding', async () => {
    const d = doc();
    if (!d?.path) return;
    if (d.isDirty()) {
      service('notifications').info(
        'Save or revert the file first.',
        'Reopening with another encoding replaces the text.',
      );
      return;
    }
    const picked = await pickEncoding('Reopen with encoding');
    if (picked) await documents.reload(d, { encoding: picked.id as TextEncoding });
  });
  run('editor.changeIndentation', async () => {
    const d = doc();
    if (!d) return;
    const action = await service('quickInput').pick(
      [
        { id: 'spaces', label: 'Indent using spaces' },
        { id: 'tabs', label: 'Indent using tabs' },
        { id: 'convert-spaces', label: 'Convert indentation to spaces' },
        { id: 'convert-tabs', label: 'Convert indentation to tabs' },
      ],
      { placeholder: 'Select an action', title: 'Change indentation' },
    );
    if (!action) return;
    const sizes = await service('quickInput').pick(
      [1, 2, 3, 4, 6, 8].map((n) => ({ id: String(n), label: String(n) })),
      { placeholder: 'Select the tab size', title: 'Tab size', activeIds: [String(d.tabSize)] },
    );
    if (!sizes) return;
    const tabSize = Number(sizes.id);
    const insertSpaces = action.id === 'spaces' || action.id === 'convert-spaces';
    documents.setIndentation(d, {
      insertSpaces,
      tabSize,
      convert: action.id.startsWith('convert'),
    });
  });

  // --- commands: navigation and Monaco actions ----------------------------------------------

  run('go.back', () => editorService.goHistory('back'));
  run('go.forward', () => editorService.goHistory('forward'));
  run('go.nextProblem', () => runAction('editor.action.marker.next'));
  run('go.previousProblem', () => runAction('editor.action.marker.prev'));
  run('go.definition', () => runAction('editor.action.revealDefinition'));
  run('go.references', () => runAction('editor.action.goToReferences'));

  const passthrough: Record<string, string> = {
    'edit.undo': 'undo',
    'edit.redo': 'redo',
    'edit.cut': 'editor.action.clipboardCutAction',
    'edit.copy': 'editor.action.clipboardCopyAction',
    'edit.paste': 'editor.action.clipboardPasteAction',
    'edit.find': 'actions.find',
    'edit.replace': 'editor.action.startFindReplace',
    'edit.toggleLineComment': 'editor.action.commentLine',
    'edit.toggleBlockComment': 'editor.action.blockComment',
    'edit.formatDocument': 'editor.action.formatDocument',
    'edit.formatSelection': 'editor.action.formatSelection',
    'edit.trimTrailingWhitespace': 'editor.action.trimTrailingWhitespace',
    'selection.selectAll': 'editor.action.selectAll',
    'selection.expand': 'editor.action.smartSelect.expand',
    'selection.shrink': 'editor.action.smartSelect.shrink',
    'selection.copyLineUp': 'editor.action.copyLinesUpAction',
    'selection.copyLineDown': 'editor.action.copyLinesDownAction',
    'selection.moveLineUp': 'editor.action.moveLinesUpAction',
    'selection.moveLineDown': 'editor.action.moveLinesDownAction',
    'selection.addCursorAbove': 'editor.action.insertCursorAbove',
    'selection.addCursorBelow': 'editor.action.insertCursorBelow',
    'selection.addNextOccurrence': 'editor.action.addSelectionToNextFindMatch',
    'selection.selectAllOccurrences': 'editor.action.selectHighlights',
  };
  for (const [id, action] of Object.entries(passthrough)) {
    run(id, () => {
      const editor = activeEditor();
      if (action === 'undo' || action === 'redo') editor?.trigger('menu', action, null);
      else runAction(action);
    });
  }

  // Restore the previous session (or show the welcome page) once every slice has registered.
  setTimeout(() => void openStartup(), 0);
}
