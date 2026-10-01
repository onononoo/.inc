import type { ComponentType } from 'react';
import { create } from 'zustand';
import type { CustomEditorProps } from '../contracts/editor';

/** A position to reveal in a document once its editor is showing it. */
export interface RevealRequest {
  docKey: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  nonce: number;
}

interface RequestState {
  reveal: RevealRequest | null;
  /** Bumped when the editor should take keyboard focus. */
  focusNonce: number;
  /** Group the next focus request is for. */
  focusGroupId: number | null;
}

export const useEditorRequests = create<RequestState>(() => ({
  reveal: null,
  focusNonce: 0,
  focusGroupId: null,
}));

let nonce = 0;

export function requestReveal(request: Omit<RevealRequest, 'nonce'>): void {
  useEditorRequests.setState({ reveal: { ...request, nonce: ++nonce } });
}

export function requestFocus(groupId: number | null = null): void {
  useEditorRequests.setState((s) => ({ focusNonce: s.focusNonce + 1, focusGroupId: groupId }));
}

interface CustomEditorState {
  components: Record<string, ComponentType<CustomEditorProps>>;
}

/** Components that render non-file tabs (settings, shortcuts, welcome), by kind. */
export const useCustomEditors = create<CustomEditorState>(() => ({ components: {} }));

export function registerCustomComponent(
  kind: string,
  component: ComponentType<CustomEditorProps>,
): () => void {
  useCustomEditors.setState((s) => ({ components: { ...s.components, [kind]: component } }));
  return () => {
    useCustomEditors.setState((s) => {
      if (s.components[kind] !== component) return s;
      const next = { ...s.components };
      delete next[kind];
      return { components: next };
    });
  };
}
