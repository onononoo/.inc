import { create } from 'zustand';
import type { WorkspaceInfo } from '@shared/api/workspace';
import { ipc } from '../services/ipc';

interface WorkspaceState {
  workspace: WorkspaceInfo | null;
  loaded: boolean;
}

export const useWorkspaceStore = create<WorkspaceState>(() => ({ workspace: null, loaded: false }));

let started = false;

export async function initWorkspace(): Promise<void> {
  if (started) return;
  started = true;
  ipc.on('workspace:changed', (workspace) => useWorkspaceStore.setState({ workspace }));
  const workspace = await ipc.invoke('workspace:get').catch(() => null);
  useWorkspaceStore.setState({ workspace, loaded: true });
}

export function getWorkspace(): WorkspaceInfo | null {
  return useWorkspaceStore.getState().workspace;
}

export function useWorkspace(): WorkspaceInfo | null {
  return useWorkspaceStore((s) => s.workspace);
}
