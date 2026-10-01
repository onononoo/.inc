/**
 * The seams between the editor logic and the outside world. Production code passes the real IPC
 * client, Monaco and the UI services (see `register.ts`); unit tests pass fakes. Keeping the
 * logic behind these small interfaces is what lets the document, save and reconcile code run in
 * Node without Monaco, Electron or a DOM.
 */
import type { editor as MonacoEditor } from 'monaco-editor';
import type { EndOfLine } from '@shared/encodings';
import type { EventChannel, EventMap, InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc';
import type { Platform } from '@shared/paths';
import type { KnownLanguage } from '../monaco/languages';
import type { DiffInput } from '../contracts/editor';
import type { Document } from './document';
import type { DocumentSettings } from './document-policy';
import type { ChoiceOptions, ConfirmOptions, NotificationOptions } from '../contracts/layout';

export type TextModel = MonacoEditor.ITextModel;

/** Same shape as `ipc` from `services/ipc.ts`. */
export interface IpcPort {
  invoke<K extends InvokeChannel>(channel: K, ...args: InvokeArgs<K>): Promise<InvokeResult<K>>;
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void;
}

export type ModelLocation = { kind: 'file'; path: string } | { kind: 'untitled'; id: number };

/** Everything the documents service needs from Monaco's runtime. */
export interface MonacoPort {
  createModel(text: string, languageId: string, location: ModelLocation): TextModel;
  setLanguage(model: TextModel, languageId: string): void;
  /** Set the model's line ending without adding an undo step (used while loading). */
  setEol(model: TextModel, eol: EndOfLine): void;
  /** Change the line ending as an undoable edit (used by the status bar picker). */
  pushEol(model: TextModel, eol: EndOfLine): void;
  knownLanguages(): KnownLanguage[];
  /** Language ids with their display names, for the language picker. */
  languageChoices(): { id: string; name: string }[];
}

/** The UI services documents talk to, resolved lazily because other slices provide them. */
export interface DocumentsUi {
  choose(options: ChoiceOptions): Promise<number>;
  confirm(options: ConfirmOptions): Promise<boolean>;
  notify(options: NotificationOptions): { dismiss: () => void };
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DocumentsDeps {
  ipc: IpcPort;
  monaco: MonacoPort;
  platform: Platform;
  /** Current effective settings. Read at call time, never cached. */
  settings: () => DocumentSettings;
  /** Folder of the open workspace, used as the default location for Save As. */
  workspaceRoot: () => string | null;
  ui: () => DocumentsUi;
  /** Show a diff tab (conflict resolution). */
  compare: (input: DiffInput) => Promise<void>;
  log: (level: LogLevel, message: string) => void;
  /** Rulers the person configured; EditorConfig's line length only adds one when there are none. */
  baseRulers?: () => readonly number[];
  /** Format the document with its language's formatter (format on save). */
  format?: (doc: Document) => Promise<void>;
}
