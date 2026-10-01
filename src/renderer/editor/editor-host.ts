import type { editor as MonacoEditor } from 'monaco-editor';
import type { Unsubscribe } from '../contracts/commands';
import type { EditorHost } from '../contracts/editor';

type Callback = (
  editor: MonacoEditor.IStandaloneCodeEditor,
  path: string | null,
) => void | Unsubscribe;

interface Registered {
  editor: MonacoEditor.IStandaloneCodeEditor;
  pathOf: () => string | null;
  /** Cleanups returned by each subscriber for the current model. */
  cleanups: Map<Callback, Unsubscribe>;
}

/**
 * Lets other slices decorate editors (the Git gutter, search highlights) without owning them. The
 * editor area registers each Monaco editor here; a subscriber is called for every editor and again
 * whenever an editor shows a different file, after the previous call's cleanup has run.
 */
export class EditorHostRegistry implements EditorHost {
  private readonly editors = new Map<MonacoEditor.IStandaloneCodeEditor, Registered>();
  private readonly subscribers = new Set<Callback>();
  private active: MonacoEditor.IStandaloneCodeEditor | null = null;

  /** Register a Monaco editor. `pathOf` reads the path of the file it currently shows. */
  register(editor: MonacoEditor.IStandaloneCodeEditor, pathOf: () => string | null): Unsubscribe {
    const entry: Registered = { editor, pathOf, cleanups: new Map() };
    this.editors.set(editor, entry);
    const run = () => {
      for (const cleanup of entry.cleanups.values()) cleanup();
      entry.cleanups.clear();
      for (const callback of this.subscribers) this.invoke(entry, callback);
    };
    run();
    const model = editor.onDidChangeModel(run);
    const focus = editor.onDidFocusEditorText(() => {
      this.active = editor;
    });
    this.active ??= editor;
    return () => {
      model.dispose();
      focus.dispose();
      for (const cleanup of entry.cleanups.values()) cleanup();
      this.editors.delete(editor);
      if (this.active === editor) this.active = [...this.editors.keys()][0] ?? null;
    };
  }

  private invoke(entry: Registered, callback: Callback): void {
    try {
      const cleanup = callback(entry.editor, entry.pathOf());
      if (typeof cleanup === 'function') entry.cleanups.set(callback, cleanup);
    } catch (error) {
      console.error('An editor subscriber failed', error);
    }
  }

  onEditor(callback: Callback): Unsubscribe {
    this.subscribers.add(callback);
    for (const entry of this.editors.values()) this.invoke(entry, callback);
    return () => {
      this.subscribers.delete(callback);
      for (const entry of this.editors.values()) {
        entry.cleanups.get(callback)?.();
        entry.cleanups.delete(callback);
      }
    };
  }

  /** The editor that most recently had focus (or the first one). */
  getActiveEditor(): MonacoEditor.IStandaloneCodeEditor | null {
    return this.active;
  }

  /** Make a specific editor the active one (the editor area does this when a group is activated). */
  setActive(editor: MonacoEditor.IStandaloneCodeEditor | null): void {
    this.active = editor;
  }

  focusActiveEditor(): void {
    this.active?.focus();
  }

  /** Every registered editor, for commands that act on a particular document. */
  all(): MonacoEditor.IStandaloneCodeEditor[] {
    return [...this.editors.keys()];
  }
}

export const editorHost = new EditorHostRegistry();
