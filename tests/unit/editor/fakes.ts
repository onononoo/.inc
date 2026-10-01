import { vi } from 'vitest';
import { IncError } from '@shared/errors';
import type { EndOfLine, TextEncoding } from '@shared/encodings';
import type { FileStat, ReadFileResult, WriteFileResult } from '@shared/api/fs';
import { defaultSettings } from '@shared/settings';
import { createDocumentsStore } from '../../../src/renderer/editor/documents-store';
import { DocumentsService } from '../../../src/renderer/editor/documents';
import { readDocumentSettings } from '../../../src/renderer/editor/document-policy';
import type {
  DocumentsDeps,
  IpcPort,
  ModelLocation,
  MonacoPort,
  TextModel,
} from '../../../src/renderer/editor/ports';

/** Just enough of Monaco's text model for the documents service. Positions are 1-based. */
export class FakeModel {
  lines: string[];
  eol = '\n';
  altVersion = 1;
  disposed = false;
  options = { insertSpaces: true, tabSize: 4 };
  languageId: string;
  readonly uri: { toString(): string };
  private readonly listeners = new Set<() => void>();

  constructor(
    text: string,
    languageId: string,
    readonly location: ModelLocation,
  ) {
    this.lines = text.split(/\r\n|\r|\n/);
    this.languageId = languageId;
    this.uri = {
      toString: () =>
        location.kind === 'file' ? `file:///${location.path}` : `untitled:${location.id}`,
    };
  }

  getValue(): string {
    return this.lines.join(this.eol);
  }
  setValue(text: string): void {
    this.lines = text.split(/\r\n|\r|\n/);
    this.touch();
  }
  getAlternativeVersionId(): number {
    return this.altVersion;
  }
  getLineCount(): number {
    return this.lines.length;
  }
  getLineContent(n: number): string {
    return this.lines[n - 1] ?? '';
  }
  getLineMaxColumn(n: number): number {
    return (this.lines[n - 1]?.length ?? 0) + 1;
  }
  updateOptions(options: { insertSpaces?: boolean; tabSize?: number }): void {
    Object.assign(this.options, options);
  }
  pushStackElement(): void {}
  dispose(): void {
    this.disposed = true;
  }
  onDidChangeContent(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  private offset(line: number, column: number): number {
    let offset = 0;
    for (let i = 1; i < line; i++) offset += (this.lines[i - 1]?.length ?? 0) + 1;
    return offset + column - 1;
  }

  pushEditOperations(
    _selections: unknown,
    edits: {
      range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
      text: string;
    }[],
  ): null {
    let text = this.lines.join('\n');
    const sorted = [...edits].sort(
      (a, b) =>
        b.range.startLineNumber - a.range.startLineNumber ||
        b.range.startColumn - a.range.startColumn,
    );
    for (const edit of sorted) {
      const start = this.offset(edit.range.startLineNumber, edit.range.startColumn);
      const end = this.offset(edit.range.endLineNumber, edit.range.endColumn);
      text = text.slice(0, start) + edit.text.replace(/\r\n|\r/g, '\n') + text.slice(end);
    }
    this.lines = text.split('\n');
    this.touch();
    return null;
  }

  private touch(): void {
    this.altVersion++;
    for (const listener of [...this.listeners]) listener();
  }
}

export interface VirtualFile {
  content: string;
  encoding?: TextEncoding;
  eol?: EndOfLine;
  mtimeMs: number;
  kind?: 'text' | 'binary' | 'tooLarge';
}

export class VirtualFs {
  files = new Map<string, VirtualFile>();
  clock = 1_000;
  writes: { path: string; content: string; options: unknown }[] = [];
  failWrite: IncError | null = null;
  editorConfig: Record<string, unknown> = {};
  savePath: string | null = null;

  set(path: string, content: string, extra: Partial<VirtualFile> = {}): void {
    this.files.set(path, { content, mtimeMs: ++this.clock, ...extra });
  }

  touch(path: string, content: string): void {
    this.set(path, content);
  }

  remove(path: string): void {
    this.files.delete(path);
  }

  private need(path: string): VirtualFile {
    const file = this.files.get(path);
    if (!file) throw new IncError('E_NOT_FOUND', `Not found: ${path}`);
    return file;
  }

  handlers: Record<string, (...args: never[]) => unknown> = {
    'fs:readFile': ((path: string, options?: { encoding?: TextEncoding }): ReadFileResult => {
      const file = this.need(path);
      const eol: EndOfLine = file.eol ?? (file.content.includes('\r\n') ? 'crlf' : 'lf');
      return {
        path,
        kind: file.kind ?? 'text',
        content: file.kind && file.kind !== 'text' ? '' : file.content,
        encoding: options?.encoding ?? file.encoding ?? 'utf8',
        eol,
        mixedEol: false,
        size: file.content.length,
        mtimeMs: file.mtimeMs,
      };
    }) as never,
    'fs:stat': ((path: string): FileStat => {
      const file = this.need(path);
      return {
        path,
        kind: 'file',
        isSymlink: false,
        size: file.content.length,
        mtimeMs: file.mtimeMs,
        birthtimeMs: 0,
        readonly: false,
      };
    }) as never,
    'fs:writeFile': ((
      path: string,
      content: string,
      options?: { expectedMtimeMs?: number | null; encoding?: TextEncoding },
    ): WriteFileResult => {
      if (this.failWrite) throw this.failWrite;
      const existing = this.files.get(path);
      if (
        options?.expectedMtimeMs !== undefined &&
        existing &&
        existing.mtimeMs !== options.expectedMtimeMs
      ) {
        throw new IncError('E_MODIFIED_SINCE', 'The file changed on disk.');
      }
      this.writes.push({ path, content, options });
      this.set(path, content, { encoding: options?.encoding });
      const written = this.files.get(path) as VirtualFile;
      return { mtimeMs: written.mtimeMs, size: content.length };
    }) as never,
    'editorconfig:resolve': (() => this.editorConfig) as never,
    'dialog:saveAs': (() => this.savePath) as never,
  };
}

export interface Harness {
  service: DocumentsService;
  fs: VirtualFs;
  models: FakeModel[];
  notifications: {
    level?: string;
    message: string;
    actions?: { label: string; run: () => void }[];
  }[];
  choices: number[];
  confirms: boolean[];
  compared: unknown[];
  settings: ReturnType<typeof defaultSettings>;
  logs: string[];
}

export function harness(): Harness {
  const fs = new VirtualFs();
  const models: FakeModel[] = [];
  const notifications: Harness['notifications'] = [];
  const choices: number[] = [];
  const confirms: boolean[] = [];
  const compared: unknown[] = [];
  const logs: string[] = [];
  const settings = defaultSettings();
  settings['editor.detectIndentation'] = true;

  const ipc: IpcPort = {
    invoke: (async (channel: string, ...args: never[]) => {
      const handler = fs.handlers[channel];
      if (!handler) throw new Error(`Unhandled channel ${channel}`);
      return handler(...args);
    }) as IpcPort['invoke'],
    on: () => () => undefined,
  };

  const monaco: MonacoPort = {
    createModel: (text, languageId, location) => {
      const model = new FakeModel(text, languageId, location);
      models.push(model);
      return model as unknown as TextModel;
    },
    setLanguage: (model, languageId) => {
      (model as unknown as FakeModel).languageId = languageId;
    },
    setEol: (model, eol) => {
      (model as unknown as FakeModel).eol = eol === 'crlf' ? '\r\n' : '\n';
    },
    pushEol: (model, eol) => {
      const fake = model as unknown as FakeModel;
      fake.eol = eol === 'crlf' ? '\r\n' : '\n';
      fake.altVersion++;
      for (const listener of (fake as unknown as { listeners: Set<() => void> }).listeners)
        listener();
    },
    knownLanguages: () => [],
    languageChoices: () => [],
  };

  const deps: DocumentsDeps = {
    ipc,
    monaco,
    platform: 'linux',
    settings: () => readDocumentSettings((key) => settings[key]),
    workspaceRoot: () => '/ws',
    ui: () => ({
      choose: vi.fn(async () => choices.shift() ?? 2),
      confirm: vi.fn(async () => confirms.shift() ?? true),
      notify: (options) => {
        notifications.push(options);
        return { dismiss: () => undefined };
      },
    }),
    compare: async (input) => void compared.push(input),
    log: (_level, message) => void logs.push(message),
  };

  const service = new DocumentsService(deps, createDocumentsStore());
  return { service, fs, models, notifications, choices, confirms, compared, settings, logs };
}
