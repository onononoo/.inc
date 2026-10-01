/**
 * The documents service: the single owner of every file-backed (and untitled) text model.
 *
 * It loads files (encoding, line endings, EditorConfig, large-file handling), saves them through a
 * pipeline (whitespace rules, format on save, atomic write, conflict detection), keeps them in
 * step with changes made outside the editor, and publishes immutable snapshots to
 * `documentsStore`. It talks to Monaco, IPC and the UI only through the ports in `ports.ts`.
 */
import { describeError, isIncError } from '@shared/errors';
import type { EndOfLine, TextEncoding } from '@shared/encodings';
import type { FsChange, ReadFileResult } from '@shared/api/fs';
import { basename, dirname, isWithin, join, pathKey } from '@shared/paths';
import { detectLanguage, languageDisplayName, PLAIN_TEXT } from '../monaco/languages';
import { Document, type DocumentInfo } from './document';
import {
  documentEditorOverrides,
  formatBytes,
  isLargeFile,
  resolveDocumentPolicy,
  type DocumentPolicy,
} from './document-policy';
import { documentsStore, type DocumentsStore } from './documents-store';
import { Emitter } from './emitter';
import type { DocumentsDeps, TextModel } from './ports';
import {
  convertIndentationEdits,
  detectIndentation,
  finalNewlineEdit,
  firstLineOf,
  minimalLineReplacement,
  reindentEdits,
  replacementToEdit,
  splitLines,
  trailingWhitespaceEdits,
  type LineSource,
  type TextEdit,
} from './text-transforms';

/** Hints from the status bar and commands that decide how a changed file on disk is handled. */
export interface RenameEvent {
  from: { key: string; path: string };
  to: { key: string; path: string };
}

function lineSourceOf(model: TextModel): LineSource {
  return { lineCount: model.getLineCount(), line: (n) => model.getLineContent(n) };
}

function applyEdits(model: TextModel, edits: readonly TextEdit[]): void {
  if (edits.length === 0) return;
  model.pushEditOperations(
    [],
    edits.map((e) => ({ range: e.range, text: e.text })),
    () => null,
  );
}

export class DocumentsService {
  private readonly docs = new Map<string, Document>();
  private readonly opening = new Map<string, Promise<Document>>();
  private nextUntitled = 1;
  private readonly recentlyClosed: string[] = [];

  readonly onDidOpen = new Emitter<Document>();
  readonly onDidClose = new Emitter<Document>();
  readonly onDidChange = new Emitter<Document>();
  readonly onDidRename = new Emitter<RenameEvent>();

  constructor(
    private readonly deps: DocumentsDeps,
    private readonly store: DocumentsStore = documentsStore,
  ) {}

  // --- lookup -------------------------------------------------------------------------------

  keyFor(path: string): string {
    return pathKey(path, this.deps.platform);
  }

  get(key: string): Document | undefined {
    return this.docs.get(key);
  }

  getByPath(path: string): Document | undefined {
    return this.docs.get(this.keyFor(path));
  }

  all(): Document[] {
    return [...this.docs.values()];
  }

  openPaths(): string[] {
    return this.all()
      .map((d) => d.path)
      .filter((p): p is string => p !== null);
  }

  dirtyDocuments(): Document[] {
    return this.all().filter((d) => d.isDirty());
  }

  /** Most recently closed file paths, newest first. */
  closedPaths(): string[] {
    return [...this.recentlyClosed];
  }

  takeClosedPath(): string | undefined {
    return this.recentlyClosed.shift();
  }

  // --- publishing ---------------------------------------------------------------------------

  /** Publish a document's current state to the store and tell listeners. */
  publish(doc: Document): void {
    const info = doc.snapshot();
    this.store.setState((state) => {
      const docs = { ...state.docs, [doc.key]: info };
      return { docs, dirtyCount: Object.values(docs).filter((d) => d.dirty).length };
    });
    this.onDidChange.fire(doc);
  }

  private unpublish(doc: Document): void {
    this.store.setState((state) => {
      const docs = { ...state.docs };
      delete docs[doc.key];
      return { docs, dirtyCount: Object.values(docs).filter((d) => d.dirty).length };
    });
  }

  info(key: string): DocumentInfo | undefined {
    return this.store.getState().docs[key];
  }

  // --- opening ------------------------------------------------------------------------------

  /** Open a file, or return the document that is already open for it. */
  open(path: string, options: { loadAnyway?: boolean } = {}): Promise<Document> {
    const key = this.keyFor(path);
    const existing = this.docs.get(key);
    if (existing && !(options.loadAnyway && existing.kind === 'tooLarge')) {
      return Promise.resolve(existing);
    }
    const pending = this.opening.get(key);
    if (pending) return pending;
    const job = this.load(path, key, options.loadAnyway === true).finally(() => {
      this.opening.delete(key);
    });
    this.opening.set(key, job);
    return job;
  }

  private async resolvePolicy(path: string): Promise<DocumentPolicy> {
    const settings = this.deps.settings();
    let config = null;
    if (settings['files.useEditorConfig']) {
      config = await this.deps.ipc.invoke('editorconfig:resolve', path).catch(() => null);
    }
    return resolveDocumentPolicy(settings, config, this.deps.platform);
  }

  private async load(path: string, key: string, loadAnyway: boolean): Promise<Document> {
    const settings = this.deps.settings();
    const result = await this.deps.ipc.invoke('fs:readFile', path, {
      ...(loadAnyway ? { maxBytes: 512 * 1024 * 1024 } : {}),
    });
    const name = basename(path);
    const known = this.deps.monaco.knownLanguages();
    const stale = this.docs.get(key);

    if (result.kind !== 'text') {
      const doc = new Document({
        key,
        path,
        untitledId: null,
        name,
        kind: result.kind,
        model: null,
        size: result.size,
        mtimeMs: result.mtimeMs,
        languageId: PLAIN_TEXT,
        languageName: languageDisplayName(PLAIN_TEXT, known),
        encoding: result.encoding,
        eol: result.eol,
        mixedEol: false,
        insertSpaces: settings['editor.insertSpaces'],
        tabSize: settings['editor.tabSize'],
      });
      this.register(doc, stale);
      return doc;
    }

    const policy = await this.resolvePolicy(path);
    const large = isLargeFile(result.size, settings['editor.largeFileThresholdMB']);
    const languageId = large
      ? PLAIN_TEXT
      : detectLanguage(name, firstLineOf(result.content), known);
    const model = this.deps.monaco.createModel(result.content, languageId, { kind: 'file', path });
    this.deps.monaco.setEol(model, result.eol);

    let insertSpaces = policy.indent.insertSpaces;
    let tabSize = policy.indent.tabSize;
    if (policy.indent.detect && !large) {
      const detected = detectIndentation(lineSourceOf(model), tabSize);
      if (detected) {
        insertSpaces = detected.insertSpaces;
        tabSize = detected.tabSize;
      }
    }
    model.updateOptions({ insertSpaces, tabSize });

    const doc = new Document({
      key,
      path,
      untitledId: null,
      name,
      kind: 'text',
      model,
      size: result.size,
      mtimeMs: result.mtimeMs,
      languageId,
      languageName: languageDisplayName(languageId, known),
      encoding: result.encoding,
      eol: result.eol,
      mixedEol: result.mixedEol,
      insertSpaces,
      tabSize,
    });
    doc.largeFile = large;
    doc.overrides = documentEditorOverrides({
      large,
      maxLineLength: policy.maxLineLength,
      baseRulers: this.deps.baseRulers?.() ?? [],
      readOnly: false,
    });
    doc.markClean();
    this.attach(doc);
    this.register(doc, stale);
    return doc;
  }

  private register(doc: Document, replaced: Document | undefined): void {
    if (replaced) this.disposeDocument(replaced, false);
    this.docs.set(doc.key, doc);
    this.publish(doc);
    this.onDidOpen.fire(doc);
  }

  /** New untitled buffer. Its language comes from the first line once there is one. */
  openUntitled(initialText = '', languageId: string = PLAIN_TEXT): Document {
    const id = this.nextUntitled++;
    const settings = this.deps.settings();
    const policy = resolveDocumentPolicy(settings, null, this.deps.platform);
    const model = this.deps.monaco.createModel(initialText, languageId, { kind: 'untitled', id });
    this.deps.monaco.setEol(model, policy.newFileEol);
    model.updateOptions({
      insertSpaces: policy.indent.insertSpaces,
      tabSize: policy.indent.tabSize,
    });
    const known = this.deps.monaco.knownLanguages();
    const doc = new Document({
      key: `untitled:${id}`,
      path: null,
      untitledId: id,
      name: `Untitled-${id}`,
      kind: 'text',
      model,
      size: 0,
      mtimeMs: null,
      languageId,
      languageName: languageDisplayName(languageId, known),
      encoding: policy.newFileEncoding,
      eol: policy.newFileEol,
      mixedEol: false,
      insertSpaces: policy.indent.insertSpaces,
      tabSize: policy.indent.tabSize,
    });
    doc.cleanAltVersion = initialText === '' ? model.getAlternativeVersionId() : null;
    this.attach(doc);
    this.register(doc, undefined);
    return doc;
  }

  /** Subscribe to the document's model so edits mark it dirty and schedule auto save. */
  private attach(doc: Document): void {
    const model = doc.model;
    if (!model) return;
    const content = model.onDidChangeContent(() => {
      this.publish(doc);
      this.scheduleAutoSave(doc);
      if (doc.isUntitled && !doc.languageExplicit) this.redetectUntitled(doc, model);
    });
    doc.disposers.push(() => content.dispose());
  }

  private redetectUntitled(doc: Document, model: TextModel): void {
    const first = firstLineOf(model.getLineContent(1));
    if (first === doc.lastFirstLine) return;
    doc.lastFirstLine = first;
    const detected = detectLanguage(doc.name, first, this.deps.monaco.knownLanguages());
    if (detected !== doc.languageId) this.applyLanguage(doc, detected, false);
  }

  // --- closing ------------------------------------------------------------------------------

  /** Release a document. Unsaved edits are lost: callers confirm first. */
  close(doc: Document): void {
    if (!this.docs.has(doc.key)) return;
    if (doc.path) {
      this.recentlyClosed.unshift(doc.path);
      this.recentlyClosed.splice(20);
    }
    this.disposeDocument(doc, true);
  }

  private disposeDocument(doc: Document, forget: boolean): void {
    doc.releaseListeners();
    doc.conflictNotice?.dismiss();
    doc.model?.dispose();
    if (forget) {
      this.docs.delete(doc.key);
      this.unpublish(doc);
      this.onDidClose.fire(doc);
    }
  }

  // --- saving -------------------------------------------------------------------------------

  private scheduleAutoSave(doc: Document): void {
    const settings = this.deps.settings();
    if (settings['files.autoSave'] !== 'afterDelay' || doc.isUntitled || !doc.isDirty()) return;
    if (doc.autoSaveTimer) clearTimeout(doc.autoSaveTimer);
    doc.autoSaveTimer = setTimeout(
      () => {
        doc.autoSaveTimer = undefined;
        if (doc.isDirty() && !doc.conflict) void this.save(doc);
      },
      Math.max(100, settings['files.autoSaveDelay']),
    );
  }

  /** Save every dirty file-backed document (auto save on focus or window change). */
  async saveDirtyFiles(): Promise<void> {
    for (const doc of this.dirtyDocuments()) {
      if (doc.path && !doc.conflict) await this.save(doc);
    }
  }

  /** Save a document. Untitled buffers ask for a location. Resolves true when it is on disk. */
  save(doc: Document, options: { saveAs?: boolean } = {}): Promise<boolean> {
    const run = doc.queue.then(() => this.doSave(doc, options.saveAs === true));
    doc.queue = run.catch(() => undefined);
    return run;
  }

  async saveAs(doc: Document): Promise<boolean> {
    return this.save(doc, { saveAs: true });
  }

  async saveAll(): Promise<boolean> {
    let ok = true;
    for (const doc of this.dirtyDocuments()) ok = (await this.save(doc)) && ok;
    return ok;
  }

  private async pickSavePath(doc: Document): Promise<string | null> {
    const root = this.deps.workspaceRoot();
    const base = doc.path ? dirname(doc.path) : root;
    const defaultPath = base ? join(base, doc.name) : undefined;
    return this.deps.ipc.invoke('dialog:saveAs', {
      title: 'Save as',
      ...(defaultPath ? { defaultPath } : {}),
    });
  }

  private async doSave(doc: Document, saveAs: boolean): Promise<boolean> {
    if (doc.kind !== 'text' || !doc.model) return true;
    let target = doc.path;
    if (saveAs || target === null) {
      target = await this.pickSavePath(doc);
      if (!target) return false;
    }
    const clash = this.getByPath(target);
    if (clash && clash !== doc) {
      const ok = await this.deps.ui().confirm({
        title: `Replace ${basename(target)}?`,
        message: 'This file is open in another tab. Saving here replaces it.',
        confirmLabel: 'Replace',
        danger: true,
      });
      if (!ok) return false;
    }

    const policy = await this.resolvePolicy(target);
    const model = doc.model;
    doc.saving = true;
    this.publish(doc);
    try {
      await this.prepareForSave(doc, model, policy);
      const text = model.getValue();
      const expected = saveAs || doc.deletedOnDisk ? undefined : (doc.mtimeMs ?? undefined);
      const written = await this.write(doc, target, text, expected);
      if (!written) return false;
      if (target !== doc.path) this.retarget(doc, target);
      doc.mtimeMs = written.mtimeMs;
      doc.size = written.size;
      doc.conflict = false;
      doc.deletedOnDisk = false;
      doc.conflictNotice?.dismiss();
      doc.conflictNotice = null;
      doc.markClean();
      return true;
    } finally {
      doc.saving = false;
      this.publish(doc);
    }
  }

  private async prepareForSave(doc: Document, model: TextModel, policy: DocumentPolicy) {
    const settings = this.deps.settings();
    if (settings['editor.formatOnSave'] && this.deps.format) {
      await this.deps.format(doc).catch((error) => {
        this.deps.log('warn', `Format on save failed for ${doc.name}: ${describeError(error)}`);
      });
    }
    const edits: TextEdit[] = [];
    if (policy.trimTrailingWhitespace) edits.push(...trailingWhitespaceEdits(lineSourceOf(model)));
    if (edits.length > 0) {
      model.pushStackElement();
      applyEdits(model, edits);
      model.pushStackElement();
    }
    if (policy.insertFinalNewline) {
      const final = finalNewlineEdit(lineSourceOf(model), doc.eol);
      if (final) {
        model.pushStackElement();
        applyEdits(model, [final]);
        model.pushStackElement();
      }
    }
  }

  /** Write with conflict handling. Returns the new metadata, or null when the save was abandoned. */
  private async write(
    doc: Document,
    target: string,
    text: string,
    expectedMtimeMs: number | undefined,
  ): Promise<{ mtimeMs: number; size: number } | null> {
    const attempt = (expected: number | undefined) =>
      this.deps.ipc.invoke('fs:writeFile', target, text, {
        encoding: doc.encoding,
        createDirs: true,
        ...(expected !== undefined ? { expectedMtimeMs: expected } : {}),
      });
    try {
      return await attempt(expectedMtimeMs);
    } catch (error) {
      if (isIncError(error, 'E_MODIFIED_SINCE')) {
        const choice = await this.deps.ui().choose({
          title: `${doc.name} changed on disk`,
          message: 'The file was modified outside the editor since you opened it.',
          detail: 'Overwrite replaces the file with your version. Compare shows both side by side.',
          buttons: [
            { label: 'Overwrite', danger: true },
            { label: 'Compare' },
            { label: 'Cancel', primary: true },
          ],
          cancelIndex: 2,
        });
        if (choice === 0) return this.writeAfterRefusal(doc, target, attempt);
        if (choice === 1) await this.compareWithDisk(doc);
        return null;
      }
      this.reportSaveFailure(doc, error);
      return null;
    }
  }

  private async writeAfterRefusal(
    doc: Document,
    target: string,
    attempt: (expected: number | undefined) => Promise<{ mtimeMs: number; size: number }>,
  ): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      return await attempt(undefined);
    } catch (error) {
      this.reportSaveFailure(doc, error, target);
      return null;
    }
  }

  private reportSaveFailure(doc: Document, error: unknown, target?: string): void {
    const name = target ? basename(target) : doc.name;
    this.deps.ui().notify({
      level: 'error',
      message: `Could not save ${name}.`,
      detail: describeError(error),
      key: `save:${doc.key}`,
      actions: [{ label: 'Retry', run: () => void this.save(doc) }],
    });
  }

  /** The document is now backed by a different file (Save As). */
  private retarget(doc: Document, path: string): void {
    const old = { key: doc.key, path: doc.path ?? doc.key };
    const text = doc.model?.getValue() ?? '';
    const oldModel = doc.model;
    const wasUntitled = doc.isUntitled;
    const known = this.deps.monaco.knownLanguages();
    const languageId = doc.languageExplicit
      ? doc.languageId
      : detectLanguage(basename(path), firstLineOf(text), known);
    this.docs.delete(doc.key);
    doc.releaseListeners();
    const model = this.deps.monaco.createModel(text, languageId, { kind: 'file', path });
    this.deps.monaco.setEol(model, doc.eol);
    model.updateOptions({ insertSpaces: doc.insertSpaces, tabSize: doc.tabSize });
    oldModel?.dispose();
    doc.model = model;
    doc.modelRevision++;
    doc.key = this.keyFor(path);
    doc.path = path;
    (doc as { untitledId: number | null }).untitledId = null;
    doc.name = basename(path);
    doc.languageId = languageId;
    doc.languageName = languageDisplayName(languageId, known);
    this.docs.set(doc.key, doc);
    this.attach(doc);
    this.unpublishKey(old.key);
    if (wasUntitled || old.key !== doc.key) {
      this.onDidRename.fire({ from: { key: old.key, path: old.path }, to: { key: doc.key, path } });
    }
  }

  private unpublishKey(key: string): void {
    this.store.setState((state) => {
      const docs = { ...state.docs };
      delete docs[key];
      return { docs, dirtyCount: Object.values(docs).filter((d) => d.dirty).length };
    });
  }

  // --- reverting and reloading --------------------------------------------------------------

  /** Replace the text with what is on disk, keeping the view where it was. */
  async reload(doc: Document, options: { encoding?: TextEncoding } = {}): Promise<void> {
    if (!doc.path) return;
    const path = doc.path;
    const result: ReadFileResult = await this.deps.ipc.invoke('fs:readFile', path, {
      ...(options.encoding ? { encoding: options.encoding } : {}),
    });
    if (result.kind !== 'text' || !doc.model) {
      doc.kind = result.kind;
      doc.size = result.size;
      doc.mtimeMs = result.mtimeMs;
      this.publish(doc);
      return;
    }
    this.replaceText(doc, result.content);
    doc.size = result.size;
    doc.mtimeMs = result.mtimeMs;
    doc.encoding = options.encoding ?? result.encoding;
    if (options.encoding) doc.encodingExplicit = true;
    if (!doc.eolExplicit) {
      doc.eol = result.eol;
      this.deps.monaco.setEol(doc.model, result.eol);
    }
    doc.mixedEol = result.mixedEol;
    doc.conflict = false;
    doc.deletedOnDisk = false;
    doc.conflictNotice?.dismiss();
    doc.conflictNotice = null;
    doc.markClean();
    this.publish(doc);
  }

  /** Make the model hold `text` with the smallest edit, so cursors and folding are not disturbed. */
  private replaceText(doc: Document, text: string): void {
    const model = doc.model;
    if (!model) return;
    const oldLines = splitLines(model.getValue());
    const replacement = minimalLineReplacement(oldLines, splitLines(text));
    if (!replacement) return;
    const edit = replacementToEdit(
      replacement,
      model.getLineCount(),
      (n) => model.getLineMaxColumn(n),
      doc.eol,
    );
    model.pushStackElement();
    applyEdits(model, [edit]);
    model.pushStackElement();
  }

  async revert(doc: Document): Promise<void> {
    if (doc.isUntitled) {
      doc.model?.setValue('');
      doc.cleanAltVersion = doc.model?.getAlternativeVersionId() ?? null;
      this.publish(doc);
      return;
    }
    await this.reload(doc);
  }

  // --- external changes ---------------------------------------------------------------------

  /** Reconcile open documents with a batch of file system changes. */
  async applyFsChanges(changes: readonly FsChange[]): Promise<void> {
    if (changes.some((c) => c.resync)) {
      await Promise.all(
        this.all()
          .filter((d) => d.path)
          .map((d) => this.checkOnDisk(d)),
      );
      return;
    }
    for (const change of changes) {
      const doc = this.getByPath(change.path);
      if (!doc) continue;
      if (change.type === 'delete') {
        doc.deletedOnDisk = true;
        this.publish(doc);
      } else {
        await this.checkOnDisk(doc);
      }
    }
  }

  private async checkOnDisk(doc: Document): Promise<void> {
    if (!doc.path || doc.saving) return;
    let stat;
    try {
      stat = await this.deps.ipc.invoke('fs:stat', doc.path);
    } catch (error) {
      if (isIncError(error, 'E_NOT_FOUND') && !doc.deletedOnDisk) {
        doc.deletedOnDisk = true;
        this.publish(doc);
      }
      return;
    }
    if (doc.deletedOnDisk) {
      doc.deletedOnDisk = false;
      this.publish(doc);
    }
    if (doc.mtimeMs !== null && Math.abs(stat.mtimeMs - doc.mtimeMs) < 1 && stat.size === doc.size)
      return;
    if (!doc.isDirty()) {
      await this.reload(doc).catch((error) =>
        this.deps.log('warn', `Could not reload ${doc.name}: ${describeError(error)}`),
      );
      return;
    }
    if (doc.conflict) return;
    doc.conflict = true;
    this.publish(doc);
    this.askAboutConflict(doc);
  }

  private askAboutConflict(doc: Document): void {
    doc.conflictNotice?.dismiss();
    doc.conflictNotice = this.deps.ui().notify({
      level: 'warning',
      message: `${doc.name} changed on disk.`,
      detail: 'You have unsaved changes in this file.',
      timeout: 0,
      key: `conflict:${doc.key}`,
      actions: [
        { label: 'Reload', run: () => void this.reload(doc) },
        { label: 'Keep mine', run: () => this.keepMine(doc) },
        { label: 'Compare', run: () => void this.compareWithDisk(doc) },
      ],
    });
  }

  /** The person chose their own version: accept the on-disk timestamp so the next save is allowed. */
  keepMine(doc: Document): void {
    if (!doc.path) return;
    void this.deps.ipc.invoke('fs:stat', doc.path).then((stat) => {
      doc.mtimeMs = stat.mtimeMs;
      doc.size = stat.size;
      doc.conflict = false;
      doc.conflictNotice?.dismiss();
      doc.conflictNotice = null;
      this.publish(doc);
    });
  }

  async compareWithDisk(doc: Document): Promise<void> {
    if (!doc.path || !doc.model) return;
    const disk = await this.deps.ipc.invoke('fs:readFile', doc.path, {
      encoding: doc.encoding,
    });
    if (disk.kind !== 'text') return;
    await this.deps.compare({
      path: doc.path,
      originalLabel: 'On disk',
      originalText: disk.content,
      modified: { kind: 'file' },
      title: `${doc.name} (on disk) ↔ ${doc.name} (editor)`,
    });
  }

  // --- paths that moved ---------------------------------------------------------------------

  /** A file or folder was renamed or moved: documents under it follow the new path. */
  renamePath(from: string, to: string): void {
    const platform = this.deps.platform;
    for (const doc of this.all()) {
      if (!doc.path) continue;
      let next: string | null = null;
      if (this.keyFor(doc.path) === this.keyFor(from)) next = to;
      else if (isWithin(from, doc.path, platform)) {
        next = join(to, doc.path.slice(from.length).replace(/^[\\/]+/, ''));
      }
      if (next) this.retargetInPlace(doc, next);
    }
  }

  private retargetInPlace(doc: Document, path: string): void {
    const wasDirty = doc.isDirty();
    this.retarget(doc, path);
    if (wasDirty) doc.cleanAltVersion = null;
    else doc.markClean();
    this.publish(doc);
  }

  /** Close every document under a folder (it was deleted or moved away). */
  closeUnder(folder: string): Document[] {
    const closed: Document[] = [];
    for (const doc of this.all()) {
      if (!doc.path) continue;
      if (
        this.keyFor(doc.path) === this.keyFor(folder) ||
        isWithin(folder, doc.path, this.deps.platform)
      ) {
        this.close(doc);
        closed.push(doc);
      }
    }
    return closed;
  }

  // --- status bar pickers -------------------------------------------------------------------

  setLanguage(doc: Document, languageId: string): void {
    this.applyLanguage(doc, languageId, true);
  }

  private applyLanguage(doc: Document, languageId: string, explicit: boolean): void {
    if (!doc.model) return;
    this.deps.monaco.setLanguage(doc.model, languageId);
    doc.languageId = languageId;
    doc.languageName = languageDisplayName(languageId, this.deps.monaco.knownLanguages());
    if (explicit) doc.languageExplicit = true;
    this.publish(doc);
  }

  setEol(doc: Document, eol: EndOfLine): void {
    if (!doc.model) return;
    this.deps.monaco.pushEol(doc.model, eol);
    doc.eol = eol;
    doc.eolExplicit = true;
    doc.mixedEol = false;
    this.publish(doc);
  }

  /** Change the encoding used on the next save. */
  setSaveEncoding(doc: Document, encoding: TextEncoding): void {
    doc.encoding = encoding;
    doc.encodingExplicit = true;
    this.publish(doc);
  }

  /** Change the indentation settings of one document; optionally convert the existing text. */
  setIndentation(
    doc: Document,
    options: { insertSpaces: boolean; tabSize: number; convert: boolean },
  ): void {
    const model = doc.model;
    if (!model) return;
    if (options.convert) {
      const source = lineSourceOf(model);
      const edits = options.insertSpaces
        ? convertIndentationEdits(source, 'spaces', options.tabSize)
        : convertIndentationEdits(source, 'tabs', options.tabSize);
      model.pushStackElement();
      applyEdits(model, edits);
      model.pushStackElement();
    }
    model.updateOptions({ insertSpaces: options.insertSpaces, tabSize: options.tabSize });
    doc.insertSpaces = options.insertSpaces;
    doc.tabSize = options.tabSize;
    this.publish(doc);
  }

  /** Re-indent existing text from one tab width to another (a "reindent" of the whole file). */
  reindent(doc: Document, from: number, to: number, insertSpaces: boolean): void {
    const model = doc.model;
    if (!model) return;
    model.pushStackElement();
    applyEdits(
      model,
      reindentEdits(lineSourceOf(model), {
        fromSize: from,
        toSize: to,
        insertSpaces,
        tabSize: Math.max(from, to),
      }),
    );
    model.pushStackElement();
    this.setIndentation(doc, { insertSpaces, tabSize: to, convert: false });
  }

  /** One line for the large-file notice: how big the file is and what that costs. */
  describeLarge(doc: Document): string {
    return `${doc.name} is ${formatBytes(doc.size)}. Some editor features are turned off to keep it fast.`;
  }

  /** Dispose everything (window closing). */
  dispose(): void {
    for (const doc of this.all()) this.disposeDocument(doc, false);
    this.docs.clear();
    this.store.setState({ docs: {}, dirtyCount: 0 });
  }
}
