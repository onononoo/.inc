import { afterEach, describe, expect, it, vi } from 'vitest';
import { IncError } from '@shared/errors';
import type { Document } from '../../../src/renderer/editor/document';
import { harness, type FakeModel } from './fakes';

const model = (doc: Document) => doc.model as unknown as FakeModel;

afterEach(() => vi.useRealTimers());

describe('opening files', () => {
  it('loads text with its language, line endings and indentation, clean', async () => {
    const h = harness();
    h.fs.set('/ws/a.ts', 'function f() {\r\n  return 1;\r\n}\r\n');
    const doc = await h.service.open('/ws/a.ts');
    expect(doc).toMatchObject({ kind: 'text', name: 'a.ts', eol: 'crlf', encoding: 'utf8' });
    expect(model(doc).getValue()).toBe('function f() {\r\n  return 1;\r\n}\r\n');
    expect(doc.isDirty()).toBe(false);
    expect(model(doc).options).toEqual({ insertSpaces: true, tabSize: 2 });
    expect(h.service.info(doc.key)).toMatchObject({ dirty: false, eol: 'crlf', name: 'a.ts' });
  });

  it('returns the same document for the same path and shares an in-flight open', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const [a, b] = await Promise.all([h.service.open('/ws/a.txt'), h.service.open('/ws/a.txt')]);
    expect(a).toBe(b);
    expect(await h.service.open('/ws/a.txt')).toBe(a);
    expect(h.models).toHaveLength(1);
  });

  it('opens binary and oversized files without a model', async () => {
    const h = harness();
    h.fs.set('/ws/a.bin', '', { kind: 'binary' });
    h.fs.set('/ws/huge.log', 'x', { kind: 'tooLarge' });
    const bin = await h.service.open('/ws/a.bin');
    const huge = await h.service.open('/ws/huge.log');
    expect(bin).toMatchObject({ kind: 'binary', model: null });
    expect(huge).toMatchObject({ kind: 'tooLarge', model: null });
    expect(bin.isDirty()).toBe(false);
  });

  it('applies EditorConfig indentation instead of detecting it', async () => {
    const h = harness();
    h.fs.editorConfig = { indentStyle: 'tab', tabWidth: 8 };
    h.fs.set('/ws/a.ts', 'a\n  b\n');
    const doc = await h.service.open('/ws/a.ts');
    expect(model(doc).options).toEqual({ insertSpaces: false, tabSize: 8 });
  });

  it('fails with the file system error for a missing file', async () => {
    const h = harness();
    await expect(h.service.open('/ws/missing.txt')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
  });
});

describe('dirty tracking', () => {
  it('is dirty after an edit and clean again when the saved state is restored', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'hello');
    const doc = await h.service.open('/ws/a.txt');
    const before = model(doc).altVersion;
    model(doc).setValue('hello world');
    expect(doc.isDirty()).toBe(true);
    expect(h.service.info(doc.key)?.dirty).toBe(true);
    expect(h.service.dirtyDocuments()).toEqual([doc]);
    // Undo restores the saved alternative version id.
    model(doc).altVersion = before;
    expect(doc.isDirty()).toBe(false);
  });
});

describe('saving', () => {
  it('writes with the document encoding and the expected modification time', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one', { encoding: 'utf16le' });
    const doc = await h.service.open('/ws/a.txt');
    const opened = doc.mtimeMs;
    model(doc).setValue('two');
    expect(await h.service.save(doc)).toBe(true);
    expect(h.fs.writes.at(-1)).toMatchObject({
      path: '/ws/a.txt',
      content: 'two',
      options: { encoding: 'utf16le', expectedMtimeMs: opened },
    });
    expect(doc.isDirty()).toBe(false);
    expect(doc.mtimeMs).toBe(h.fs.files.get('/ws/a.txt')?.mtimeMs);
  });

  it('keeps CRLF files CRLF', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'a\r\nb\r\n');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('a\nb\nc');
    await h.service.save(doc);
    expect(h.fs.writes.at(-1)?.content).toBe('a\r\nb\r\nc');
  });

  it('trims trailing whitespace and adds a final newline when the settings ask for it', async () => {
    const h = harness();
    h.settings['files.trimTrailingWhitespace'] = true;
    h.settings['files.insertFinalNewline'] = true;
    h.fs.set('/ws/a.txt', 'x');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('one   \ntwo\t');
    await h.service.save(doc);
    expect(h.fs.writes.at(-1)?.content).toBe('one\ntwo\n');
  });

  it('lets EditorConfig override the whitespace settings', async () => {
    const h = harness();
    h.settings['files.trimTrailingWhitespace'] = true;
    h.fs.editorConfig = { trimTrailingWhitespace: false, insertFinalNewline: false };
    h.fs.set('/ws/a.txt', 'x');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('one  ');
    await h.service.save(doc);
    expect(h.fs.writes.at(-1)?.content).toBe('one  ');
  });

  it('asks what to do when the file changed on disk: overwrite', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('mine');
    h.fs.touch('/ws/a.txt', 'theirs');
    h.choices.push(0); // Overwrite
    expect(await h.service.save(doc)).toBe(true);
    expect(h.fs.files.get('/ws/a.txt')?.content).toBe('mine');
    expect(doc.isDirty()).toBe(false);
  });

  it('cancel leaves the file and the unsaved edits alone', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('mine');
    h.fs.touch('/ws/a.txt', 'theirs');
    h.choices.push(2); // Cancel
    expect(await h.service.save(doc)).toBe(false);
    expect(h.fs.files.get('/ws/a.txt')?.content).toBe('theirs');
    expect(doc.isDirty()).toBe(true);
  });

  it('compare opens the on-disk text next to the editor and does not save', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('mine');
    h.fs.touch('/ws/a.txt', 'theirs');
    h.choices.push(1); // Compare
    expect(await h.service.save(doc)).toBe(false);
    expect(h.compared).toHaveLength(1);
    expect(h.compared[0]).toMatchObject({
      path: '/ws/a.txt',
      originalText: 'theirs',
      modified: { kind: 'file' },
    });
  });

  it('reports a failed save with a retry action and stays dirty', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('two');
    h.fs.failWrite = new IncError('E_PERMISSION', 'permission denied');
    expect(await h.service.save(doc)).toBe(false);
    expect(doc.isDirty()).toBe(true);
    const note = h.notifications.at(-1);
    expect(note).toMatchObject({ level: 'error', message: 'Could not save a.txt.' });
    h.fs.failWrite = null;
    note?.actions?.[0]?.run();
    await vi.waitFor(() => expect(doc.isDirty()).toBe(false));
  });

  it('serialises concurrent saves of one document', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('two');
    const results = await Promise.all([h.service.save(doc), h.service.save(doc)]);
    expect(results).toEqual([true, true]);
    expect(h.fs.writes).toHaveLength(2);
  });

  it('saves an untitled buffer as a file and renames its tab', async () => {
    const h = harness();
    const doc = h.service.openUntitled('hello');
    expect(doc).toMatchObject({ name: 'Untitled-1', path: null });
    expect(doc.isDirty()).toBe(true);
    const renames: unknown[] = [];
    h.service.onDidRename.event((e) => renames.push(e));
    h.fs.savePath = '/ws/new.ts';
    expect(await h.service.save(doc)).toBe(true);
    expect(h.fs.files.get('/ws/new.ts')?.content).toBe('hello');
    expect(doc).toMatchObject({ path: '/ws/new.ts', name: 'new.ts', untitledId: null });
    expect(doc.isDirty()).toBe(false);
    expect(renames).toEqual([
      { from: { key: 'untitled:1', path: 'untitled:1' }, to: { key: doc.key, path: '/ws/new.ts' } },
    ]);
    expect(h.service.get('untitled:1')).toBeUndefined();
    expect(h.service.getByPath('/ws/new.ts')).toBe(doc);
  });

  it('cancelling Save As leaves the untitled buffer open and dirty', async () => {
    const h = harness();
    const doc = h.service.openUntitled('text');
    h.fs.savePath = null;
    expect(await h.service.save(doc)).toBe(false);
    expect(doc.isDirty()).toBe(true);
  });

  it('auto saves after the configured delay and not for untitled buffers', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.settings['files.autoSave'] = 'afterDelay';
    h.settings['files.autoSaveDelay'] = 500;
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('two');
    await vi.advanceTimersByTimeAsync(499);
    expect(h.fs.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.fs.files.get('/ws/a.txt')?.content).toBe('two');

    const untitled = h.service.openUntitled('x');
    model(untitled).setValue('y');
    await vi.advanceTimersByTimeAsync(2000);
    expect(untitled.isDirty()).toBe(true);
  });

  it('saveAll saves every dirty file', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'a');
    h.fs.set('/ws/b.txt', 'b');
    const a = await h.service.open('/ws/a.txt');
    const b = await h.service.open('/ws/b.txt');
    model(a).setValue('a2');
    model(b).setValue('b2');
    expect(await h.service.saveAll()).toBe(true);
    expect(h.fs.files.get('/ws/a.txt')?.content).toBe('a2');
    expect(h.fs.files.get('/ws/b.txt')?.content).toBe('b2');
    expect(h.service.dirtyDocuments()).toEqual([]);
  });
});

describe('changes outside the editor', () => {
  it('reloads a clean document silently and keeps untouched lines', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one\ntwo\nthree');
    const doc = await h.service.open('/ws/a.txt');
    h.fs.touch('/ws/a.txt', 'one\n2\nthree');
    await h.service.applyFsChanges([{ type: 'update', path: '/ws/a.txt' }]);
    expect(model(doc).getValue()).toBe('one\n2\nthree');
    expect(doc.isDirty()).toBe(false);
    expect(h.notifications).toEqual([]);
  });

  it('ignores its own writes', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('two');
    await h.service.save(doc);
    const reads = vi.spyOn(model(doc), 'setValue');
    await h.service.applyFsChanges([{ type: 'update', path: '/ws/a.txt' }]);
    expect(reads).not.toHaveBeenCalled();
    expect(doc.conflict).toBe(false);
  });

  it('flags a conflict when a dirty document changes on disk, and offers reload, keep mine and compare', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('mine');
    h.fs.touch('/ws/a.txt', 'theirs');
    await h.service.applyFsChanges([{ type: 'update', path: '/ws/a.txt' }]);
    expect(doc.conflict).toBe(true);
    expect(model(doc).getValue()).toBe('mine');
    const note = h.notifications.at(-1);
    expect(note?.actions?.map((a) => a.label)).toEqual(['Reload', 'Keep mine', 'Compare']);

    // Only one notice per conflict.
    await h.service.applyFsChanges([{ type: 'update', path: '/ws/a.txt' }]);
    expect(h.notifications).toHaveLength(1);

    note?.actions?.[0]?.run(); // Reload
    await vi.waitFor(() => expect(model(doc).getValue()).toBe('theirs'));
    expect(doc.conflict).toBe(false);
    expect(doc.isDirty()).toBe(false);
  });

  it('keep mine accepts the disk timestamp so the next save goes through', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('mine');
    h.fs.touch('/ws/a.txt', 'theirs');
    await h.service.applyFsChanges([{ type: 'update', path: '/ws/a.txt' }]);
    h.notifications.at(-1)?.actions?.[1]?.run();
    await vi.waitFor(() => expect(doc.conflict).toBe(false));
    expect(await h.service.save(doc)).toBe(true);
    expect(h.fs.files.get('/ws/a.txt')?.content).toBe('mine');
  });

  it('marks a deleted file and lets it be saved again', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    h.fs.remove('/ws/a.txt');
    await h.service.applyFsChanges([{ type: 'delete', path: '/ws/a.txt' }]);
    expect(doc.deletedOnDisk).toBe(true);
    expect(h.service.info(doc.key)?.deletedOnDisk).toBe(true);
    model(doc).setValue('back');
    expect(await h.service.save(doc)).toBe(true);
    expect(h.fs.files.get('/ws/a.txt')?.content).toBe('back');
    expect(doc.deletedOnDisk).toBe(false);
  });

  it('checks every open file after a resync', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'a');
    h.fs.set('/ws/b.txt', 'b');
    const a = await h.service.open('/ws/a.txt');
    const b = await h.service.open('/ws/b.txt');
    h.fs.touch('/ws/a.txt', 'a2');
    h.fs.remove('/ws/b.txt');
    await h.service.applyFsChanges([{ type: 'update', path: '/ws', resync: true }]);
    expect(model(a).getValue()).toBe('a2');
    expect(b.deletedOnDisk).toBe(true);
  });
});

describe('moved and closed paths', () => {
  it('follows a renamed file and keeps unsaved edits dirty', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'one');
    const doc = await h.service.open('/ws/a.txt');
    model(doc).setValue('edited');
    const events: unknown[] = [];
    h.service.onDidRename.event((e) => events.push(e));
    h.service.renamePath('/ws/a.txt', '/ws/b.md');
    expect(doc).toMatchObject({ path: '/ws/b.md', name: 'b.md' });
    expect(model(doc).getValue()).toBe('edited');
    expect(doc.isDirty()).toBe(true);
    expect(events).toHaveLength(1);
    expect(h.service.getByPath('/ws/b.md')).toBe(doc);
    expect(h.service.getByPath('/ws/a.txt')).toBeUndefined();
  });

  it('follows a renamed folder', async () => {
    const h = harness();
    h.fs.set('/ws/src/a.ts', 'a');
    h.fs.set('/ws/src/deep/b.ts', 'b');
    h.fs.set('/ws/other.ts', 'c');
    const a = await h.service.open('/ws/src/a.ts');
    const b = await h.service.open('/ws/src/deep/b.ts');
    const c = await h.service.open('/ws/other.ts');
    h.service.renamePath('/ws/src', '/ws/lib');
    expect(a.path).toBe('/ws/lib/a.ts');
    expect(b.path).toBe('/ws/lib/deep/b.ts');
    expect(c.path).toBe('/ws/other.ts');
    expect(a.isDirty()).toBe(false);
  });

  it('closes documents under a deleted folder and remembers them for reopening', async () => {
    const h = harness();
    h.fs.set('/ws/src/a.ts', 'a');
    h.fs.set('/ws/keep.ts', 'k');
    await h.service.open('/ws/src/a.ts');
    await h.service.open('/ws/keep.ts');
    const closed = h.service.closeUnder('/ws/src');
    expect(closed.map((d) => d.path)).toEqual(['/ws/src/a.ts']);
    expect(h.service.openPaths()).toEqual(['/ws/keep.ts']);
    expect(h.service.takeClosedPath()).toBe('/ws/src/a.ts');
    expect(h.service.takeClosedPath()).toBeUndefined();
  });

  it('disposes the model when a document closes', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'a');
    const doc = await h.service.open('/ws/a.txt');
    const m = model(doc);
    h.service.close(doc);
    expect(m.disposed).toBe(true);
    expect(h.service.info(doc.key)).toBeUndefined();
  });
});

describe('status bar changes', () => {
  it('changes line endings, encoding and language', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'a\nb');
    const doc = await h.service.open('/ws/a.txt');
    h.service.setEol(doc, 'crlf');
    expect(model(doc).getValue()).toBe('a\r\nb');
    expect(doc.isDirty()).toBe(true);
    h.service.setSaveEncoding(doc, 'windows1252');
    h.service.setLanguage(doc, 'markdown');
    expect(h.service.info(doc.key)).toMatchObject({
      eol: 'crlf',
      encoding: 'windows1252',
      languageId: 'markdown',
    });
    await h.service.save(doc);
    expect(h.fs.writes.at(-1)).toMatchObject({
      content: 'a\r\nb',
      options: { encoding: 'windows1252' },
    });
  });

  it('reopens a clean file with another encoding', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'café');
    const doc = await h.service.open('/ws/a.txt');
    await h.service.reload(doc, { encoding: 'windows1252' });
    expect(doc.encoding).toBe('windows1252');
    expect(doc.encodingExplicit).toBe(true);
    expect(doc.isDirty()).toBe(false);
  });

  it('converts indentation between tabs and spaces', async () => {
    const h = harness();
    h.fs.set('/ws/a.txt', 'a\n    b\n        c');
    const doc = await h.service.open('/ws/a.txt');
    h.service.setIndentation(doc, { insertSpaces: false, tabSize: 4, convert: true });
    expect(model(doc).getValue()).toBe('a\n\tb\n\t\tc');
    expect(doc.insertSpaces).toBe(false);
    expect(doc.isDirty()).toBe(true);
  });
});
