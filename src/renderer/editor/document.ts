/**
 * One open document: a Monaco text model plus everything .inc remembers about the file behind it.
 *
 * `Document` is a state holder. The documents service is the only code that mutates it; the rest
 * of the app reads `info()` (an immutable snapshot, also published to `useDocuments`) or uses
 * `model` to attach editors.
 */
import type { EndOfLine, TextEncoding } from '@shared/encodings';
import type { EditorOptionOverrides } from './editor-options';
import type { TextModel } from './ports';

export type DocumentKind = 'text' | 'binary' | 'tooLarge';

/** Cursor and scroll position in a form that can be stored in the session. */
export interface CompactViewState {
  line: number;
  column: number;
  scrollTop: number;
  scrollLeft: number;
}

/** Immutable snapshot of a document, safe to keep in React state. */
export interface DocumentInfo {
  /** Stable identity: `pathKey(path)` for files, `untitled:N` for untitled buffers. */
  key: string;
  /** Absolute path, or null for an untitled buffer. */
  path: string | null;
  untitledId: number | null;
  /** File name or `Untitled-N`. */
  name: string;
  uri: string;
  /** `binary` and `tooLarge` documents have no model; the editor shows an explanation instead. */
  kind: DocumentKind;
  size: number;
  mtimeMs: number | null;
  languageId: string;
  languageName: string;
  encoding: TextEncoding;
  eol: EndOfLine;
  /** The file had a mix of line endings; they are normalised to `eol` on save. */
  mixedEol: boolean;
  dirty: boolean;
  /** The file changed on disk while this document had unsaved edits. */
  conflict: boolean;
  deletedOnDisk: boolean;
  saving: boolean;
  readOnly: boolean;
  /** Expensive editor features are off for this document (see `editor.largeFileThresholdMB`). */
  largeFile: boolean;
  insertSpaces: boolean;
  tabSize: number;
  /** Increases whenever the underlying model instance is replaced (rename, Save As). */
  modelRevision: number;
}

export class Document {
  key: string;
  path: string | null;
  readonly untitledId: number | null;
  name: string;
  kind: DocumentKind;
  model: TextModel | null;
  size: number;
  mtimeMs: number | null;
  languageId: string;
  languageName: string;
  /** True once the language was chosen by the person rather than detected. */
  languageExplicit = false;
  encoding: TextEncoding;
  /** True once the encoding was chosen by the person rather than detected. */
  encodingExplicit = false;
  eol: EndOfLine;
  eolExplicit = false;
  mixedEol: boolean;
  conflict = false;
  deletedOnDisk = false;
  saving = false;
  readOnly = false;
  largeFile = false;
  modelRevision = 0;
  /**
   * Alternative version id of the model at the last save or load. `null` means "never clean"
   * (an untitled buffer with initial text, or a document whose model was recreated while dirty).
   */
  cleanAltVersion: number | null = null;
  /** Per-document editor option overrides (large file, EditorConfig ruler, read only). */
  overrides: EditorOptionOverrides = {};
  /** Saved Monaco view states by editor group id (opaque to everything except the editor registry). */
  readonly viewStates = new Map<number, unknown>();
  /** Cursor and scroll restored from the previous session, applied the first time an editor shows the document. */
  initialView: CompactViewState | null = null;
  /** Subscriptions bound to the current model; released when the model is replaced or disposed. */
  disposers: (() => void)[] = [];
  /** Timer of a pending after-delay auto save. */
  autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Serialises saves and reloads of this document. */
  queue: Promise<unknown> = Promise.resolve();
  /** Notification currently asking about an external change, so it can be withdrawn. */
  conflictNotice: { dismiss: () => void } | null = null;
  /** First line last inspected for language detection of an untitled buffer. */
  lastFirstLine = '';
  insertSpaces: boolean;
  tabSize: number;

  constructor(init: {
    key: string;
    path: string | null;
    untitledId: number | null;
    name: string;
    kind: DocumentKind;
    model: TextModel | null;
    size: number;
    mtimeMs: number | null;
    languageId: string;
    languageName: string;
    encoding: TextEncoding;
    eol: EndOfLine;
    mixedEol: boolean;
    insertSpaces: boolean;
    tabSize: number;
  }) {
    this.key = init.key;
    this.path = init.path;
    this.untitledId = init.untitledId;
    this.name = init.name;
    this.kind = init.kind;
    this.model = init.model;
    this.size = init.size;
    this.mtimeMs = init.mtimeMs;
    this.languageId = init.languageId;
    this.languageName = init.languageName;
    this.encoding = init.encoding;
    this.eol = init.eol;
    this.mixedEol = init.mixedEol;
    this.insertSpaces = init.insertSpaces;
    this.tabSize = init.tabSize;
  }

  get isUntitled(): boolean {
    return this.untitledId !== null;
  }

  /** True when the model has edits that are not on disk. Undoing back to the saved text is clean. */
  isDirty(): boolean {
    if (this.kind !== 'text' || !this.model) return false;
    return (
      this.cleanAltVersion === null || this.model.getAlternativeVersionId() !== this.cleanAltVersion
    );
  }

  /** Record the model's current content as the saved state. */
  markClean(): void {
    if (this.model) this.cleanAltVersion = this.model.getAlternativeVersionId();
  }

  snapshot(): DocumentInfo {
    return {
      key: this.key,
      path: this.path,
      untitledId: this.untitledId,
      name: this.name,
      uri: this.model ? this.model.uri.toString() : (this.path ?? this.key),
      kind: this.kind,
      size: this.size,
      mtimeMs: this.mtimeMs,
      languageId: this.languageId,
      languageName: this.languageName,
      encoding: this.encoding,
      eol: this.eol,
      mixedEol: this.mixedEol,
      dirty: this.isDirty(),
      conflict: this.conflict,
      deletedOnDisk: this.deletedOnDisk,
      saving: this.saving,
      readOnly: this.readOnly,
      largeFile: this.largeFile,
      insertSpaces: this.insertSpaces,
      tabSize: this.tabSize,
      modelRevision: this.modelRevision,
    };
  }

  /** Release subscriptions and the pending auto save. Does not dispose the model. */
  releaseListeners(): void {
    for (const dispose of this.disposers.splice(0)) dispose();
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = undefined;
  }
}
