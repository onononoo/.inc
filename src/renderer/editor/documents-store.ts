import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { DocumentInfo } from './document';

export interface DocumentsState {
  /** Snapshots by document key, in the order documents were opened. */
  docs: Record<string, DocumentInfo>;
  /** Count of dirty documents (drives the `hasDirtyEditors` context key and the window title). */
  dirtyCount: number;
}

export type DocumentsStore = StoreApi<DocumentsState>;

export function createDocumentsStore(): DocumentsStore {
  return createStore<DocumentsState>(() => ({ docs: {}, dirtyCount: 0 }));
}

/** The application-wide store, fed by the documents service created in `register.ts`. */
export const documentsStore: DocumentsStore = createDocumentsStore();

/** React hook over the application-wide documents store. */
export function useDocuments<T>(selector: (state: DocumentsState) => T): T {
  return useStore(documentsStore, selector);
}

/** React hook: the snapshot of one document, or undefined when it is not open. */
export function useDocumentInfo(key: string | null | undefined): DocumentInfo | undefined {
  return useStore(documentsStore, (s) => (key ? s.docs[key] : undefined));
}
