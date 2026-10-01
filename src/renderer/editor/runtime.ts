import type { DocumentsService } from './documents';
import type { EditorServiceImpl } from './editor-service';
import type { NavigationHistory } from './nav-history';

export interface EditorRuntime {
  documents: DocumentsService;
  service: EditorServiceImpl;
  navigation: NavigationHistory;
}

let current: EditorRuntime | null = null;

/** Set once by the editor slice's register(); the editor components read it. */
export function setEditorRuntime(runtime: EditorRuntime): void {
  current = runtime;
}

export function editorRuntime(): EditorRuntime {
  if (!current) throw new Error('The editor has not been registered yet');
  return current;
}
