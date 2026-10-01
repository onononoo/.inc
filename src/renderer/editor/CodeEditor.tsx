import { useEffect, useRef } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  createEditorOptions,
  createEditorUpdateOptions,
  monaco,
  readEditorSettings,
} from '../monaco';
import { service } from '../services/registry';
import { getSetting, useSettingsStore } from '../state/settings-store';
import type { DocumentInfo } from './document';
import { editorHost } from './editor-host';
import { useEditorRequests } from './editor-requests';
import { setActiveGroup } from './groups-model';
import { updateGroups } from './groups-store';
import { editorRuntime } from './runtime';
import { setEditorStatus } from './status-store';

interface CodeEditorProps {
  groupId: number;
  /** The text document to show, or null when the group is showing something else. */
  doc: DocumentInfo | null;
  /** Whether this group is the active one (its cursor drives the status bar). */
  groupActive: boolean;
}

/** Largest selection whose characters are counted exactly; beyond this the count is an estimate. */
const COUNT_LIMIT = 5_000_000;

function buildStatus(editor: MonacoEditor.IStandaloneCodeEditor, info: DocumentInfo) {
  const model = editor.getModel();
  const position = editor.getPosition();
  let chars = 0;
  let lines = 0;
  if (model) {
    for (const selection of editor.getSelections() ?? []) {
      if (selection.isEmpty()) continue;
      chars += Math.min(model.getValueLengthInRange(selection), COUNT_LIMIT);
      lines += selection.endLineNumber - selection.startLineNumber + 1;
    }
  }
  return {
    path: info.path,
    languageId: info.languageId,
    languageName: info.languageName,
    line: position?.lineNumber ?? 1,
    column: position?.column ?? 1,
    selectedChars: chars,
    selectedLines: lines,
    insertSpaces: info.insertSpaces,
    tabSize: info.tabSize,
    eol: info.eol,
    encoding: info.encoding,
    dirty: info.dirty,
    readOnly: info.readOnly,
  };
}

/**
 * One Monaco editor for one group. It is created once and shows whichever document the group's
 * active tab points at: switching tabs swaps the model and restores that document's cursor and
 * scroll position for this group.
 */
export function CodeEditor({ groupId, doc, groupActive }: CodeEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const shownKey = useRef<string | null>(null);
  const docRef = useRef<DocumentInfo | null>(doc);
  const activeRef = useRef(groupActive);

  useEffect(() => {
    docRef.current = doc;
    activeRef.current = groupActive;
  });

  // Create the editor once.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const runtime = editorRuntime();
    const settings = readEditorSettings(getSetting);
    const editor = monaco.editor.create(element, {
      ...createEditorOptions(settings),
      model: null,
    });
    editorRef.current = editor;

    const unregister = editorHost.register(editor, () => {
      const model = editor.getModel();
      return model && model.uri.scheme === 'file' ? model.uri.fsPath : null;
    });

    const refreshStatus = () => {
      const info = docRef.current;
      if (activeRef.current && info) setEditorStatus(buildStatus(editor, info));
    };

    const observer = new ResizeObserver(() => editor.layout());
    observer.observe(element);

    const disposables = [
      editor.onDidFocusEditorText(() => {
        updateGroups((state) => setActiveGroup(state, groupId));
        editorHost.setActive(editor);
        service('contextKeys').set('editorFocus', true);
        refreshStatus();
      }),
      editor.onDidBlurEditorText(() => {
        service('contextKeys').set('editorFocus', false);
        const info = docRef.current;
        if (info && getSetting('files.autoSave') === 'onFocusChange') {
          const document = runtime.documents.get(info.key);
          if (document?.isDirty() && document.path) void runtime.documents.save(document);
        }
      }),
      editor.onDidChangeCursorSelection(() => {
        refreshStatus();
        const info = docRef.current;
        const position = editor.getPosition();
        if (info?.path && position && !runtime.service.isNavigating()) {
          runtime.navigation.record({
            path: info.path,
            line: position.lineNumber,
            column: position.column,
          });
        }
      }),
      editor.onDidChangeModelContent(() => {
        const info = docRef.current;
        if (info) runtime.service.keepOpen(info.key);
        refreshStatus();
      }),
    ];

    return () => {
      for (const d of disposables) d.dispose();
      observer.disconnect();
      unregister();
      editor.setModel(null);
      editor.dispose();
      editorRef.current = null;
      shownKey.current = null;
    };
  }, [groupId]);

  // Show the document the group points at.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const runtime = editorRuntime();
    const previous = shownKey.current ? runtime.documents.get(shownKey.current) : undefined;
    const next = doc ? runtime.documents.get(doc.key) : undefined;
    const revision = next?.modelRevision ?? -1;
    const identity = next ? `${next.key}#${revision}` : null;
    if (identity === shownKey.current && next) return;

    if (previous?.model && editor.getModel() === previous.model) {
      previous.viewStates.set(groupId, editor.saveViewState());
    }
    shownKey.current = identity;
    if (!next?.model) {
      editor.setModel(null);
      return;
    }
    editor.setModel(next.model);
    editor.updateOptions({
      ...createEditorUpdateOptions(readEditorSettings(getSetting), next.overrides),
      ariaLabel: next.name,
      readOnly: next.readOnly,
    });
    const saved = next.viewStates.get(groupId) as
      MonacoEditor.ICodeEditorViewState | null | undefined;
    if (saved) {
      editor.restoreViewState(saved);
    } else if (next.initialView) {
      const { line, column, scrollTop, scrollLeft } = next.initialView;
      editor.setPosition({ lineNumber: line, column });
      editor.setScrollPosition({ scrollTop, scrollLeft });
      next.initialView = null;
    }
    const position = editor.getPosition();
    if (next.path && position && !runtime.service.isNavigating()) {
      runtime.navigation.record({
        path: next.path,
        line: position.lineNumber,
        column: position.column,
      });
    }
    if (activeRef.current && doc) setEditorStatus(buildStatus(editor, doc));
    // The model is swapped only when the group shows a different document or model instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, doc?.key, doc?.modelRevision]);

  // Keep the status bar in step with what the document knows (encoding, line ending, dirty).
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && groupActive && doc && editor.getModel())
      setEditorStatus(buildStatus(editor, doc));
  }, [groupActive, doc]);

  // Settings changes apply to the editor that is showing a document.
  useEffect(() => {
    return useSettingsStore.subscribe(() => {
      const editor = editorRef.current;
      const info = docRef.current;
      if (!editor || !info) return;
      const document = editorRuntime().documents.get(info.key);
      editor.updateOptions({
        ...createEditorUpdateOptions(readEditorSettings(getSetting), document?.overrides ?? {}),
        readOnly: document?.readOnly ?? false,
      });
    });
  }, []);

  // Reveal a position asked for by search, problems or go to line.
  const reveal = useEditorRequests((s) => s.reveal);
  const handled = useRef(0);
  useEffect(() => {
    const editor = editorRef.current;
    if (!reveal || !editor || !doc || reveal.docKey !== doc.key || reveal.nonce === handled.current)
      return;
    if (!editor.getModel()) return;
    handled.current = reveal.nonce;
    const model = editor.getModel();
    if (!model) return;
    const line = Math.min(Math.max(reveal.line, 1), model.getLineCount());
    const column = Math.min(Math.max(reveal.column, 1), model.getLineMaxColumn(line));
    const end =
      reveal.endLine !== undefined
        ? {
            lineNumber: Math.min(Math.max(reveal.endLine, 1), model.getLineCount()),
            column: reveal.endColumn ?? 1,
          }
        : null;
    if (end) {
      editor.setSelection({
        startLineNumber: line,
        startColumn: column,
        endLineNumber: end.lineNumber,
        endColumn: Math.min(end.column, model.getLineMaxColumn(end.lineNumber)),
      });
    } else {
      editor.setPosition({ lineNumber: line, column });
    }
    editor.revealLineInCenterIfOutsideViewport(line);
  }, [reveal, doc]);

  // Move keyboard focus here when the editor service asks for it.
  const focusNonce = useEditorRequests((s) => s.focusNonce);
  const focusGroupId = useEditorRequests((s) => s.focusGroupId);
  const lastFocus = useRef(focusNonce);
  useEffect(() => {
    if (focusNonce === lastFocus.current) return;
    lastFocus.current = focusNonce;
    if (doc && (focusGroupId === null || focusGroupId === groupId)) {
      requestAnimationFrame(() => editorRef.current?.focus());
    }
  }, [focusNonce, focusGroupId, groupId, doc]);

  return <div ref={container} className="eg-code" data-testid={`code-editor-${groupId}`} />;
}
