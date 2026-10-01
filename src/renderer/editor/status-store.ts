import { create } from 'zustand';
import type { EditorStatus } from '../contracts/editor';

interface StatusState {
  /** Null when no text editor is active (welcome page, settings, an image). */
  status: EditorStatus | null;
}

export const useEditorStatus = create<StatusState>(() => ({ status: null }));

export function setEditorStatus(status: EditorStatus | null): void {
  const current = useEditorStatus.getState().status;
  if (current === status) return;
  if (current && status && JSON.stringify(current) === JSON.stringify(status)) return;
  useEditorStatus.setState({ status });
}
