import { ipc } from '../services/ipc';
import { useWorkspaceStore } from '../state/workspace-store';

const PRODUCT = '.inc';

let activeFile: { name: string; dirty: boolean } | null = null;

function compose(): string {
  const workspace = useWorkspaceStore.getState().workspace;
  const parts: string[] = [];
  if (activeFile) parts.push(`${activeFile.dirty ? '● ' : ''}${activeFile.name}`);
  if (workspace) parts.push(workspace.name);
  parts.push(PRODUCT);
  return parts.join(' - ');
}

function apply(): void {
  const title = compose();
  document.title = title;
  void ipc.invoke('window:setTitle', title).catch(() => undefined);
}

/** The editor reports its active file so the window title reads "file - folder - .inc". */
export function setActiveFileTitle(file: { name: string; dirty: boolean } | null): void {
  if (activeFile?.name === file?.name && activeFile?.dirty === file?.dirty) return;
  activeFile = file;
  apply();
}

/** Keep the title in step with the open folder. */
export function startTitleSync(): void {
  apply();
  let last = useWorkspaceStore.getState().workspace?.root ?? null;
  useWorkspaceStore.subscribe((state) => {
    const next = state.workspace?.root ?? null;
    if (next !== last) {
      last = next;
      apply();
    }
  });
}
