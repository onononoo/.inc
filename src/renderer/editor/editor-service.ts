import { describeError } from '@shared/errors';
import type {
  CustomEditorInput,
  DiffInput,
  EditorService,
  OpenFileOptions,
} from '../contracts/editor';
import type { ChoiceOptions, NotificationService } from '../contracts/layout';
import { basename } from '@shared/paths';
import type { Document } from './document';
import type { DocumentsService } from './documents';
import { registerCustomComponent, requestFocus, requestReveal } from './editor-requests';
import {
  activateTab,
  activeGroup,
  activeTab,
  closeGroup,
  closeTab,
  closeTabs,
  keepOpen,
  moveTab,
  neighbourTab,
  mruTabs,
  openDocumentKeys,
  openTab,
  setPinned,
  splitRight,
  tabIdOf,
  renameDocument,
  type Tab,
} from './groups-model';
import { documentsStore } from './documents-store';
import { groupsStore, updateGroups } from './groups-store';
import type { NavigationHistory } from './nav-history';

export interface EditorServiceDeps {
  documents: DocumentsService;
  choose: (options: ChoiceOptions) => Promise<number>;
  notifications: () => NotificationService;
  /** `workbench.previewEditors`. */
  previewEnabled: () => boolean;
  navigation: NavigationHistory;
  /** Called with a hash-able description to give a diff tab a stable id. */
  hash: (text: string) => string;
}

function diffId(hash: (text: string) => string, diff: DiffInput): string {
  const modified = diff.modified.kind === 'file' ? 'file' : diff.modified.label;
  return hash(`${diff.path}|${diff.originalLabel}|${modified}|${diff.title}`);
}

/**
 * The editor service other slices call: open files, diffs and custom tabs, save and close with the
 * unsaved-work prompts, and answer "what is open". The visual tabs and editors render the groups
 * store and the documents store; this class is the only thing that changes them.
 */
export class EditorServiceImpl implements EditorService {
  private navigating = false;

  constructor(private readonly deps: EditorServiceDeps) {
    deps.documents.onDidRename.event(({ from, to }) => {
      updateGroups((state) => renameDocument(state, from.key, to.key));
      deps.navigation.rename(from.path, to.path);
    });
  }

  private get docs(): DocumentsService {
    return this.deps.documents;
  }

  // --- opening ------------------------------------------------------------------------------

  async openFile(path: string, options: OpenFileOptions = {}): Promise<void> {
    let doc: Document;
    try {
      doc = await this.docs.open(path);
    } catch (error) {
      this.deps.notifications().error(`Could not open ${basename(path)}.`, describeError(error));
      return;
    }
    const preview = options.preview === true && this.deps.previewEnabled();
    updateGroups((state) =>
      openTab(state, { kind: 'file', key: doc.key }, { groupId: options.groupId, preview }),
    );
    if (options.line !== undefined) {
      requestReveal({
        docKey: doc.key,
        line: options.line,
        column: options.column ?? 1,
        endLine: options.endLine,
        endColumn: options.endColumn,
      });
    }
    if (options.focus !== false) requestFocus(groupsStore.getState().activeGroupId);
  }

  /** Called by the editor when a file is edited: a preview tab becomes a normal tab. */
  keepOpen(docKey: string): void {
    updateGroups((state) => keepOpen(state, tabIdOf({ kind: 'file', key: docKey })));
  }

  async openDiff(input: DiffInput): Promise<void> {
    if (input.modified.kind === 'file') {
      try {
        await this.docs.open(input.path);
      } catch (error) {
        this.deps
          .notifications()
          .error(`Could not open ${basename(input.path)}.`, describeError(error));
        return;
      }
    }
    updateGroups((state) =>
      openTab(state, { kind: 'diff', id: diffId(this.deps.hash, input), diff: input }),
    );
    requestFocus(groupsStore.getState().activeGroupId);
  }

  openCustom(input: CustomEditorInput): void {
    updateGroups((state) => openTab(state, { kind: 'custom', key: input.key, input }));
    requestFocus(groupsStore.getState().activeGroupId);
  }

  registerCustomEditor = registerCustomComponent;

  newUntitled(): void {
    const doc = this.docs.openUntitled();
    updateGroups((state) => openTab(state, { kind: 'file', key: doc.key }));
    requestFocus(groupsStore.getState().activeGroupId);
  }

  // --- navigation history -------------------------------------------------------------------

  /** True while a back or forward jump is being carried out (it must not be recorded). */
  isNavigating(): boolean {
    return this.navigating;
  }

  async goHistory(direction: 'back' | 'forward'): Promise<void> {
    const target =
      direction === 'back' ? this.deps.navigation.back() : this.deps.navigation.forward();
    if (!target) return;
    this.navigating = true;
    try {
      await this.openFile(target.path, { line: target.line, column: target.column });
    } finally {
      this.navigating = false;
    }
  }

  // --- tabs ---------------------------------------------------------------------------------

  private documentFor(tab: Tab): Document | undefined {
    return tab.input.kind === 'file' ? this.docs.get(tab.input.key) : undefined;
  }

  /**
   * Close tabs, asking about unsaved work first. A document that is still shown in another group
   * stays open. Resolves false when the person cancels (nothing after that point is closed).
   */
  async closeTabsInteractive(
    entries: readonly { groupId: number; tabId: string }[],
  ): Promise<boolean> {
    for (const { groupId, tabId } of entries) {
      const state = groupsStore.getState();
      // The same document can be open in both groups with the same tab id: look in this group.
      const group = state.groups.find((g) => g.id === groupId);
      const tab = group?.tabs.find((t) => t.id === tabId);
      if (!tab) continue;
      const doc = this.documentFor(tab);
      if (doc) {
        const stillShown = state.groups.some(
          (g) => g.id !== groupId && g.tabs.some((t) => t.id === tabId),
        );
        if (!stillShown && doc.isDirty()) {
          const choice = await this.askToSave([doc]);
          if (choice === 'cancel') return false;
          if (choice === 'save' && !(await this.docs.save(doc))) return false;
        }
        updateGroups((s) => closeTab(s, groupId, tabId));
        if (!openDocumentKeys(groupsStore.getState()).has(doc.key)) this.docs.close(doc);
      } else {
        updateGroups((s) => closeTab(s, groupId, tabId));
      }
    }
    return true;
  }

  closeTab(groupId: number, tabId: string): Promise<boolean> {
    return this.closeTabsInteractive([{ groupId, tabId }]);
  }

  closeOthers(groupId: number, keepId: string): Promise<boolean> {
    const group = groupsStore.getState().groups.find((g) => g.id === groupId);
    const targets = (group?.tabs ?? []).filter((t) => t.id !== keepId && !t.pinned);
    return this.closeTabsInteractive(targets.map((t) => ({ groupId, tabId: t.id })));
  }

  closeToRight(groupId: number, tabId: string): Promise<boolean> {
    const group = groupsStore.getState().groups.find((g) => g.id === groupId);
    const anchor = group?.tabs.findIndex((t) => t.id === tabId) ?? -1;
    const targets = (group?.tabs ?? []).filter((t, i) => i > anchor && !t.pinned);
    return this.closeTabsInteractive(targets.map((t) => ({ groupId, tabId: t.id })));
  }

  /** Close tabs whose document is saved (and tabs that are not files). */
  closeSaved(groupId: number): Promise<boolean> {
    const group = groupsStore.getState().groups.find((g) => g.id === groupId);
    const targets = (group?.tabs ?? []).filter((t) => {
      if (t.pinned) return false;
      const doc = this.documentFor(t);
      return !doc || !doc.isDirty();
    });
    return this.closeTabsInteractive(targets.map((t) => ({ groupId, tabId: t.id })));
  }

  closeAllEditors(): Promise<boolean> {
    const entries = groupsStore
      .getState()
      .groups.flatMap((g) => g.tabs.map((t) => ({ groupId: g.id, tabId: t.id })));
    return this.closeTabsInteractive(entries);
  }

  async closeActiveTab(): Promise<boolean> {
    const state = groupsStore.getState();
    const group = activeGroup(state);
    return group.activeTabId ? this.closeTab(group.id, group.activeTabId) : true;
  }

  async reopenClosed(): Promise<void> {
    const path = this.docs.takeClosedPath();
    if (path) await this.openFile(path);
  }

  activate(groupId: number, tabId: string): void {
    updateGroups((state) => activateTab(state, groupId, tabId));
    requestFocus(groupId);
  }

  step(direction: 1 | -1): void {
    const group = activeGroup(groupsStore.getState());
    const next = neighbourTab(group, direction);
    if (next) this.activate(group.id, next.id);
  }

  stepRecent(direction: 1 | -1): void {
    const group = activeGroup(groupsStore.getState());
    const ordered = mruTabs(group);
    const index = ordered.findIndex((t) => t.id === group.activeTabId);
    const next = ordered[(index + direction + ordered.length) % ordered.length];
    if (next) this.activate(group.id, next.id);
  }

  pin(groupId: number, tabId: string, pinned: boolean): void {
    updateGroups((state) => setPinned(state, groupId, tabId, pinned));
  }

  split(tabId?: string): void {
    updateGroups((state) => splitRight(state, tabId));
    requestFocus(groupsStore.getState().activeGroupId);
  }

  async closeEditorGroup(groupId: number): Promise<void> {
    updateGroups((state) => closeGroup(state, groupId));
  }

  moveToOtherGroup(): void {
    const state = groupsStore.getState();
    if (state.groups.length < 2) {
      this.split();
      return;
    }
    const source = activeGroup(state);
    const target = state.groups.find((g) => g.id !== source.id);
    if (source.activeTabId && target) {
      updateGroups((s) =>
        moveTab(s, source.id, source.activeTabId as string, target.id, target.tabs.length),
      );
    }
  }

  focusGroup(index: number): void {
    const group = groupsStore.getState().groups[index];
    if (!group) return;
    updateGroups((state) =>
      state.activeGroupId === group.id ? state : { ...state, activeGroupId: group.id },
    );
    requestFocus(group.id);
  }

  // --- saving and closing documents ---------------------------------------------------------

  async save(path?: string): Promise<boolean> {
    const doc = path ? this.docs.getByPath(path) : this.activeDocument();
    return doc ? this.docs.save(doc) : true;
  }

  saveAll(): Promise<boolean> {
    return this.docs.saveAll();
  }

  async closeFile(path: string): Promise<boolean> {
    const doc = this.docs.getByPath(path);
    if (!doc) return true;
    const entries = groupsStore
      .getState()
      .groups.flatMap((g) =>
        g.tabs
          .filter((t) => t.input.kind === 'file' && t.input.key === doc.key)
          .map((t) => ({ groupId: g.id, tabId: t.id })),
      );
    return this.closeTabsInteractive(entries);
  }

  closeFilesUnder(folder: string): void {
    for (const doc of this.docs.closeUnder(folder)) {
      const id = tabIdOf({ kind: 'file', key: doc.key });
      for (const group of groupsStore.getState().groups) {
        updateGroups((state) => closeTab(state, group.id, id));
      }
      if (doc.path) this.deps.navigation.forget(doc.path);
    }
  }

  renamePath(from: string, to: string): void {
    this.docs.renamePath(from, to);
  }

  // --- queries ------------------------------------------------------------------------------

  activeDocument(): Document | undefined {
    const group = activeGroup(groupsStore.getState());
    const tab = activeTab(group);
    return tab?.input.kind === 'file' ? this.docs.get(tab.input.key) : undefined;
  }

  getActivePath(): string | null {
    return this.activeDocument()?.path ?? null;
  }

  onDidChangeActivePath(cb: (path: string | null) => void): () => void {
    let last = this.getActivePath();
    const check = () => {
      const next = this.getActivePath();
      if (next === last) return;
      last = next;
      cb(next);
    };
    const offGroups = groupsStore.subscribe(check);
    const offDocs = documentsStore.subscribe(check);
    return () => {
      offGroups();
      offDocs();
    };
  }

  getOpenPaths(): string[] {
    return this.docs.openPaths();
  }

  getDirtyPaths(): string[] {
    return this.docs
      .dirtyDocuments()
      .map((d) => d.path)
      .filter((p): p is string => p !== null);
  }

  hasDirty(): boolean {
    return this.docs.dirtyDocuments().length > 0;
  }

  getDirtyText(path: string): string | undefined {
    const doc = this.docs.getByPath(path);
    return doc && doc.isDirty() && doc.model ? doc.model.getValue() : undefined;
  }

  // --- window close -------------------------------------------------------------------------

  private async askToSave(docs: readonly Document[]): Promise<'save' | 'discard' | 'cancel'> {
    const names = docs.map((d) => d.name);
    const shown = names.slice(0, 6).join(', ');
    const more = names.length > 6 ? ` and ${names.length - 6} more` : '';
    const single = docs.length === 1;
    const choice = await this.deps.choose({
      title: single ? `Do you want to save ${names[0]}?` : `Save changes to ${docs.length} files?`,
      message: single ? 'Your changes will be lost if you do not save them.' : `${shown}${more}`,
      detail: single ? undefined : 'Your changes will be lost if you do not save them.',
      buttons: [
        { label: single ? 'Save' : 'Save all', primary: true },
        { label: "Don't save", danger: true },
        { label: 'Cancel' },
      ],
      cancelIndex: 2,
    });
    return choice === 0 ? 'save' : choice === 1 ? 'discard' : 'cancel';
  }

  /** Resolves true when it is safe to close the window or replace the workspace. */
  async confirmCloseWindow(): Promise<boolean> {
    const dirty = this.docs.dirtyDocuments();
    if (dirty.length === 0) return true;
    const choice = await this.askToSave(dirty);
    if (choice === 'cancel') return false;
    if (choice === 'save') return this.docs.saveAll();
    return true;
  }

  /** Close every tab and document without asking (the workspace changed and the person agreed). */
  discardAll(): void {
    updateGroups(() => ({
      groups: [{ id: 1, tabs: [], activeTabId: null, mru: [] }],
      activeGroupId: 1,
      nextGroupId: 2,
    }));
    this.docs.dispose();
  }

  /** Close tabs that point at documents that no longer exist. */
  pruneTabs(): void {
    const open = new Set(this.docs.all().map((d) => d.key));
    updateGroups((state) => {
      let next = state;
      for (const group of state.groups) {
        next = closeTabs(
          next,
          group.id,
          (tab) => tab.input.kind === 'file' && !open.has(tab.input.key),
        );
      }
      return next;
    });
  }
}
