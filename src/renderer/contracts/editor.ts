import type { ComponentType } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { EndOfLine, TextEncoding } from '@shared/encodings';
import type { Unsubscribe } from './commands';

export interface OpenFileOptions {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  preview?: boolean;
  focus?: boolean;
  groupId?: number;
}

export interface DiffInput {
  /** Absolute path of the file being compared. */
  path: string;
  /** Left side label and text (for example HEAD). */
  originalLabel: string;
  originalText: string;
  /** Right side: the working file (editable) or the index version. */
  modified: { kind: 'file' } | { kind: 'text'; label: string; text: string };
  title: string;
}

/** A non-file tab (settings, keyboard shortcuts, welcome, about). */
export interface CustomEditorInput {
  kind: string;
  /** Stable key: opening the same key again focuses the existing tab. */
  key: string;
  title: string;
  icon?: string;
  /** JSON-serialisable data passed to the renderer component. */
  data?: unknown;
}

export interface CustomEditorProps {
  input: CustomEditorInput;
}

export type Severity = 'error' | 'warning' | 'info' | 'hint';

export interface Problem {
  path: string;
  severity: Severity;
  message: string;
  source?: string;
  code?: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface EditorStatus {
  path: string | null;
  languageId: string;
  languageName: string;
  line: number;
  column: number;
  selectedChars: number;
  selectedLines: number;
  insertSpaces: boolean;
  tabSize: number;
  eol: EndOfLine;
  encoding: TextEncoding;
  dirty: boolean;
  readOnly: boolean;
}

/** Owned by the editor slice (`renderer/editor`). */
export interface EditorService {
  openFile(path: string, options?: OpenFileOptions): Promise<void>;
  openDiff(input: DiffInput): Promise<void>;
  /** Open (or focus) a non-file tab whose body is rendered by a component registered with registerCustomEditor. */
  openCustom(input: CustomEditorInput): void;
  registerCustomEditor(kind: string, component: ComponentType<CustomEditorProps>): Unsubscribe;
  /** New untitled buffer. */
  newUntitled(): void;
  save(path?: string): Promise<boolean>;
  saveAll(): Promise<boolean>;
  closeFile(path: string): Promise<boolean>;
  /** Close everything under a folder (after it is deleted or moved). */
  closeFilesUnder(folder: string): void;
  /** Update open tabs after a rename or move so unsaved work follows the file. */
  renamePath(from: string, to: string): void;
  getActivePath(): string | null;
  getOpenPaths(): string[];
  getDirtyPaths(): string[];
  hasDirty(): boolean;
  /** Ask about unsaved work before the window closes; resolves true when it is safe to close. */
  confirmCloseWindow(): Promise<boolean>;
  /** Contents of an open document if it is modified, otherwise undefined (used by search and replace). */
  getDirtyText(path: string): string | undefined;
}

/** Lets other slices decorate editors (git gutter, search highlights) without owning them. */
export interface EditorHost {
  /** Called for every code editor now open and any created later. The returned function runs on dispose. */
  onEditor(
    cb: (editor: MonacoEditor.IStandaloneCodeEditor, path: string | null) => void | Unsubscribe,
  ): Unsubscribe;
  getActiveEditor(): MonacoEditor.IStandaloneCodeEditor | null;
  focusActiveEditor(): void;
}
