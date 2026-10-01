/**
 * Typed arguments for commands that other slices call programmatically:
 *   commands.execute('editor.openFile', { path, line: 12 })
 * Commands not listed here take no arguments.
 */
export interface CommandArgs {
  'editor.openFile': {
    path: string;
    line?: number;
    column?: number;
    endLine?: number;
    endColumn?: number;
    /** Open in the reusable preview tab. */
    preview?: boolean;
    /** Move keyboard focus into the editor. Default true. */
    focus?: boolean;
    groupId?: number;
  };
  'file.openFolder': { path?: string };
  'file.openFile': { path?: string };
  'explorer.reveal': { path: string };
  'git.openDiff': { path: string; staged?: boolean };
  'search.findInFiles': {
    query?: string;
    include?: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    wholeWord?: boolean;
    replace?: boolean;
    run?: boolean;
  };
  'terminal.runTask': { taskId?: string };
  'terminal.runCommand': { command: string; name?: string; cwd?: string };
  'view.showSidebar': { view: 'explorer' | 'search' | 'git' };
  'palette.show': { prefix?: string };
}

export type CommandId = string;
