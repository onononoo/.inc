import { useEffect, useRef, useState } from 'react';
import type { editor as MonacoEditor } from 'monaco-editor';
import type { DiffInput } from '../contracts/editor';
import { basename } from '@shared/paths';
import {
  createEditorOptions,
  detectLanguage,
  knownLanguages,
  monaco,
  readEditorSettings,
} from '../monaco';
import { getSetting } from '../state/settings-store';
import { IconButton } from '../ui/IconButton';
import { editorRuntime } from './runtime';

let diffCounter = 0;

/**
 * A two-sided diff of one file: the original text on the left (read only) and the working file or
 * a text snapshot on the right. When the right side is the working file, edits go through the
 * documents service, so Save works exactly as in a normal tab.
 */
export function DiffView({ diff, tabId }: { diff: DiffInput; tabId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const diffEditor = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const { documents } = editorRuntime();
    const language = detectLanguage(basename(diff.path), undefined, knownLanguages());
    const id = ++diffCounter;
    const original = monaco.editor.createModel(
      diff.originalText,
      language,
      monaco.Uri.from({ scheme: 'inc-diff', path: basename(diff.path), query: `original-${id}` }),
    );
    let modified: MonacoEditor.ITextModel | null = null;
    let ownModified = false;
    if (diff.modified.kind === 'file') {
      modified = documents.getByPath(diff.path)?.model ?? null;
    } else {
      modified = monaco.editor.createModel(
        diff.modified.text,
        language,
        monaco.Uri.from({ scheme: 'inc-diff', path: basename(diff.path), query: `modified-${id}` }),
      );
      ownModified = true;
    }
    const options = createEditorOptions(readEditorSettings(getSetting));
    const editor = monaco.editor.createDiffEditor(element, {
      ...options,
      automaticLayout: false,
      renderSideBySide: sideBySide,
      originalEditable: false,
      readOnly: diff.modified.kind !== 'file',
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      enableSplitViewResizing: true,
      useInlineViewWhenSpaceIsLimited: true,
      ariaLabel: diff.title,
    });
    diffEditor.current = editor;
    if (modified) editor.setModel({ original, modified });
    const observer = new ResizeObserver(() => editor.layout());
    observer.observe(element);
    return () => {
      observer.disconnect();
      editor.setModel(null);
      editor.dispose();
      diffEditor.current = null;
      original.dispose();
      if (ownModified) modified?.dispose();
    };
    // The diff is rebuilt only when the tab shows a different comparison.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  useEffect(() => {
    diffEditor.current?.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  return (
    <div className="eg-diff" data-testid="diff-view">
      <div className="eg-diff-bar">
        <span className="eg-diff-title">
          {diff.originalLabel} {'↔'}{' '}
          {diff.modified.kind === 'file' ? 'Working file' : diff.modified.label}
        </span>
        <IconButton
          icon="split"
          label={sideBySide ? 'Show inline' : 'Show side by side'}
          pressed={sideBySide}
          onClick={() => setSideBySide((v) => !v)}
        />
      </div>
      <div ref={container} className="eg-diff-body" />
    </div>
  );
}
