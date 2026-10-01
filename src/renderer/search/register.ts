import type { CommandArgs } from '@shared/commands/catalog';
import { ipc } from '../services/ipc';
import { hasService, service } from '../services/registry';
import { useWorkspaceStore } from '../state/workspace-store';
import {
  clearResults,
  collapseAll,
  focusQuery,
  onDone,
  onFilesChanged,
  onResults,
  restoreOptions,
  runSearch,
  setOptions,
} from './search-store';

/** Text selected on a single line of the active editor, to prefill the query. */
function selectedText(): string {
  if (!hasService('editorHost')) return '';
  const editor = service('editorHost').getActiveEditor();
  const model = editor?.getModel();
  const selection = editor?.getSelection();
  if (!editor || !model || !selection || selection.isEmpty()) return '';
  if (selection.startLineNumber !== selection.endLineNumber) return '';
  const text = model.getValueInRange(selection);
  return text.length <= 200 ? text : '';
}

/** Provides the search commands and feeds the view from the main process. */
export function register(): void {
  restoreOptions();
  ipc.on('search:results', onResults);
  ipc.on('search:done', onDone);
  ipc.on('fs:changed', (changes) => onFilesChanged(changes.map((c) => c.path)));

  let root = useWorkspaceStore.getState().workspace?.root ?? null;
  useWorkspaceStore.subscribe((state) => {
    const next = state.workspace?.root ?? null;
    if (next === root) return;
    root = next;
    clearResults();
  });

  const commands = service('commands');

  const find = async (args: CommandArgs['search.findInFiles'] | undefined, replace: boolean) => {
    service('layout').showSidebar('search', { focus: false });
    const query = args?.query ?? selectedText();
    setOptions({
      ...(query ? { query } : {}),
      ...(args?.include !== undefined ? { include: args.include } : {}),
      ...(args?.isRegex !== undefined ? { isRegex: args.isRegex } : {}),
      ...(args?.caseSensitive !== undefined ? { caseSensitive: args.caseSensitive } : {}),
      ...(args?.wholeWord !== undefined ? { wholeWord: args.wholeWord } : {}),
      replaceOpen: replace || args?.replace === true,
    });
    focusQuery();
    if (args?.run || (query && args?.query !== undefined)) await runSearch();
  };

  commands.register('search.findInFiles', ((args?: CommandArgs['search.findInFiles']) =>
    find(args, false)) as never);
  commands.register('search.replaceInFiles', () => find(undefined, true));
  commands.register('search.clearResults', () => clearResults());
  commands.register('search.collapseAll', () => collapseAll());
}
