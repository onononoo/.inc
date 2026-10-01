import type { FileSearchResult } from '@shared/api/fs';
import type { CommandDef } from '@shared/commands/types';
import { describeError } from '@shared/errors';
import type { Platform } from '@shared/paths';
import type { CommandService, KeybindingService } from '../contracts/commands';
import { buildCommandItems } from './command-items';
import {
  fileItemFromPath,
  fileItemFromSearch,
  nativePath,
  RECENT_FILES_GROUP,
  type FileTarget,
} from './file-items';
import {
  isAbsolutePathText,
  parseFileQuery,
  parseLineInput,
  routePaletteInput,
} from './palette-query';
import type {
  QuickInputController,
  QueryResult,
  QueryToken,
  QuickItem,
} from './quick-input-controller';
import type { RecentCommands } from './recent';

export const FILE_SEARCH_DEBOUNCE_MS = 40;
/** How often results are refreshed while the file index is still being built. */
export const INDEX_REFRESH_MS = 300;
const FILE_RESULT_LIMIT = 200;

/** Where the cursor is in the active editor, as far as go to line needs to know. */
export interface EditorLineInfo {
  lineCount: number;
  line: number;
  column: number;
  /** Largest valid column on a line (line length + 1). */
  maxColumn(line: number): number;
}

export interface PaletteDeps {
  platform: Platform;
  catalog: readonly CommandDef[];
  commands: Pick<CommandService, 'execute' | 'isEnabled'>;
  keybindings: Pick<KeybindingService, 'labelFor'>;
  recent: RecentCommands;
  workspaceRoot(): string | null;
  /** Paths of the files open in editors. */
  openPaths(): string[];
  searchFiles(query: string, limit: number): Promise<FileSearchResult>;
  /** True when the absolute path names an existing file. */
  isFile(path: string): Promise<boolean>;
  editorLineInfo(): EditorLineInfo | null;
  goToLine(line: number, column: number): void;
  /** Subscribe to file index progress; returns the unsubscribe. */
  onIndexProgress(listener: (progress: { indexing: boolean; count: number }) => void): () => void;
  debounceMs?: number;
  indexRefreshMs?: number;
}

export interface Palette {
  /** Open the palette with `initial` in the field: ">" commands, ":" go to line, "" quick open. */
  show(initial: string): void;
}

type PaletteTarget =
  | { kind: 'command'; id: string }
  | { kind: 'file'; target: FileTarget }
  | { kind: 'line'; line: number; column: number }
  | { kind: 'openFolder' };

const EMPTY_COMMANDS = 'No matching commands';
const EMPTY_FILES = 'No matching files';

/** A file item whose value is the palette's own target shape. */
function asFileTarget(item: QuickItem<FileTarget>): QuickItem<PaletteTarget> {
  return { ...item, value: { kind: 'file', target: item.value ?? { path: item.id } } };
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

export function createPalette(deps: PaletteDeps, controller: QuickInputController): Palette {
  const debounceMs = deps.debounceMs ?? FILE_SEARCH_DEBOUNCE_MS;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  /** The latest file results were cut short by an unfinished index, so they should be refreshed. */
  let resultsIndexing = false;

  const commandsResult = (text: string): QueryResult => {
    const { items, total } = buildCommandItems(
      text,
      {
        catalog: deps.catalog,
        isEnabled: (id) => deps.commands.isEnabled(id),
        labelFor: (id) => deps.keybindings.labelFor(id),
      },
      deps.recent.get(),
    );
    return {
      items: items.map((item) => ({
        ...item,
        value: { kind: 'command', id: item.id } satisfies PaletteTarget,
      })),
      total,
      emptyText: EMPTY_COMMANDS,
      placeholder: 'Type a command',
      ariaLabel: 'Command palette',
    };
  };

  const lineResult = (text: string): QueryResult => {
    const base = { placeholder: 'Type a line number', ariaLabel: 'Go to line' };
    const info = deps.editorLineInfo();
    if (!info) {
      return { ...base, items: [], emptyText: 'Open a file to go to a line.' };
    }
    const parsed = parseLineInput(text);
    const range =
      info.lineCount === 1 ? 'line 1' : `lines 1 to ${info.lineCount.toLocaleString('en-US')}`;
    if (parsed.kind === 'empty') {
      return {
        ...base,
        items: [],
        emptyText: `Type a line number (${range}). You are on line ${info.line.toLocaleString('en-US')}.`,
      };
    }
    if (parsed.kind === 'invalid') {
      return {
        ...base,
        items: [],
        emptyText: '',
        message: {
          tone: 'error',
          text:
            parsed.reason === 'zero'
              ? 'Line numbers start at 1.'
              : 'Enter a line number, such as 42 or 42:8.',
        },
      };
    }
    if (parsed.line > info.lineCount) {
      return {
        ...base,
        items: [],
        emptyText: '',
        message: {
          tone: 'error',
          text: `Line ${parsed.line.toLocaleString('en-US')} is past the end of the file. Enter a number between 1 and ${info.lineCount.toLocaleString('en-US')}.`,
        },
      };
    }
    const column = Math.min(parsed.column ?? 1, info.maxColumn(parsed.line));
    const label =
      parsed.column === undefined
        ? `Go to line ${parsed.line.toLocaleString('en-US')}`
        : `Go to line ${parsed.line.toLocaleString('en-US')}, column ${column.toLocaleString('en-US')}`;
    const item: QuickItem<PaletteTarget> = {
      id: 'line',
      label,
      description: `of ${plural(info.lineCount, 'line', 'lines')}`,
      value: { kind: 'line', line: parsed.line, column },
    };
    return { ...base, items: [item], emptyText: '' };
  };

  const filesResult = async (text: string, token: QueryToken): Promise<QueryResult> => {
    const base = {
      placeholder: 'Go to file (type > for commands or : for a line)',
      ariaLabel: 'Go to file',
    };
    const root = deps.workspaceRoot();
    const parsed = parseFileQuery(text);
    const position = {
      ...(parsed.line !== undefined ? { line: parsed.line } : {}),
      ...(parsed.column !== undefined ? { column: parsed.column } : {}),
    };
    const positionText =
      parsed.line === undefined
        ? undefined
        : parsed.column === undefined
          ? `Opens at line ${parsed.line.toLocaleString('en-US')}.`
          : `Opens at line ${parsed.line.toLocaleString('en-US')}, column ${parsed.column.toLocaleString('en-US')}.`;
    const info = positionText ? ({ tone: 'info', text: positionText } as const) : undefined;

    const openFolder: QuickItem<PaletteTarget> = {
      id: 'palette.openFolder',
      label: 'Open folder...',
      value: { kind: 'openFolder' },
    };

    if (parsed.query === '') {
      const items = deps
        .openPaths()
        .map((path) => fileItemFromPath(path, root, deps.platform, { group: RECENT_FILES_GROUP }))
        .map(asFileTarget);
      if (!root && items.length === 0) {
        return {
          ...base,
          items: [openFolder],
          emptyText: '',
          message: { tone: 'info', text: 'No folder is open. Open a folder to search for files.' },
        };
      }
      return {
        ...base,
        items,
        emptyText: 'No files are open. Type a name to search the workspace.',
      };
    }

    const found: QuickItem<PaletteTarget>[] = [];
    if (isAbsolutePathText(parsed.query)) {
      const path = nativePath(parsed.query, deps.platform);
      if (await deps.isFile(path).catch(() => false)) {
        if (token.stale) return { ...base, items: [] };
        found.push(asFileTarget(fileItemFromPath(path, root, deps.platform, { position })));
      }
    }

    if (!root) {
      return {
        ...base,
        items: found.length > 0 ? found : [openFolder],
        emptyText: '',
        ...(found.length === 0
          ? {
              message: {
                tone: 'info' as const,
                text: 'No folder is open. Open a folder to search for files.',
              },
            }
          : { message: info }),
      };
    }

    await sleep(debounceMs);
    if (token.stale) return { ...base, items: [] };

    let result: FileSearchResult;
    try {
      result = await deps.searchFiles(parsed.query, FILE_RESULT_LIMIT);
    } catch (error) {
      return {
        ...base,
        items: found,
        emptyText: '',
        message: { tone: 'error', text: `Could not search files. ${describeError(error)}` },
      };
    }
    const items = [
      ...found,
      ...result.items
        .filter((hit) => !found.some((f) => f.id === hit.path))
        .map((hit) => asFileTarget(fileItemFromSearch(hit, position))),
    ];
    resultsIndexing = result.indexing;
    return {
      ...base,
      items,
      total: result.total + found.length,
      emptyText: result.indexing ? '' : EMPTY_FILES,
      status: result.indexing
        ? `Indexing files (${result.indexedCount.toLocaleString('en-US')} so far). Results may be incomplete.`
        : undefined,
      message: info,
    };
  };

  const query = (value: string, token: QueryToken): QueryResult | Promise<QueryResult> => {
    resultsIndexing = false;
    const routed = routePaletteInput(value);
    switch (routed.mode) {
      case 'commands':
        return commandsResult(routed.text);
      case 'line':
        return lineResult(routed.text);
      case 'files':
        return filesResult(routed.text, token);
    }
  };

  const accept = (item: QuickItem | undefined): void => {
    const target = item?.value as PaletteTarget | undefined;
    if (!target) return;
    switch (target.kind) {
      case 'command':
        deps.recent.record(target.id);
        void deps.commands.execute(target.id);
        return;
      case 'file':
        void deps.commands.execute('editor.openFile', {
          path: target.target.path,
          ...(target.target.line !== undefined ? { line: target.target.line } : {}),
          ...(target.target.column !== undefined ? { column: target.target.column } : {}),
        });
        return;
      case 'line':
        deps.goToLine(target.line, target.column);
        return;
      case 'openFolder':
        void deps.commands.execute('file.openFolder');
        return;
    }
  };

  /** While the file index is still being built, results are refreshed as it grows. */
  const attach = (handle: { refresh(): void }): (() => void) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = deps.onIndexProgress((progress) => {
      if (!resultsIndexing || timer !== undefined) return;
      timer = setTimeout(
        () => {
          timer = undefined;
          handle.refresh();
        },
        progress.indexing ? (deps.indexRefreshMs ?? INDEX_REFRESH_MS) : 0,
      );
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
    };
  };

  return {
    show(initial) {
      controller.open({
        kind: 'pick',
        reuseKey: 'palette',
        placeholder: 'Go to file (type > for commands or : for a line)',
        ariaLabel: 'Command palette',
        initialValue: initial,
        emptyText: EMPTY_FILES,
        query,
        accept,
        attach,
      });
    },
  };
}
