import { getNodeValue } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import {
  detectEol,
  parseDocument,
  removeTopLevel,
  setTopLevel,
} from '../../../src/main/settings/jsonc';

function valueOf(text: string): unknown {
  const { root, problems } = parseDocument(text);
  expect(problems).toEqual([]);
  return root ? getNodeValue(root) : undefined;
}

describe('parseDocument', () => {
  it('accepts comments and trailing commas', () => {
    const text = '// header\n{\n  /* a */ "a": 1, // one\n  "b": [1, 2,],\n}\n';
    expect(valueOf(text)).toEqual({ a: 1, b: [1, 2] });
  });

  it('reports 1-based positions for syntax errors', () => {
    const { problems } = parseDocument('{\n  "a": 1\n  "b": 2\n}');
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatchObject({ line: 3 });
  });

  it('treats an empty or comment-only document as having no root', () => {
    expect(parseDocument('').root).toBeUndefined();
    expect(parseDocument('// nothing here\n').root).toBeUndefined();
    expect(parseDocument('').problems).toEqual([]);
  });

  it('limits the number of reported problems', () => {
    expect(parseDocument('{ , , , , , , , , , }').problems.length).toBeLessThanOrEqual(5);
  });
});

describe('setTopLevel', () => {
  it('inserts into an empty file', () => {
    const out = setTopLevel('', 'editor.fontSize', 14);
    expect(valueOf(out)).toEqual({ 'editor.fontSize': 14 });
  });

  it('inserts into the header template and keeps the header', () => {
    const template = '// User settings.\n// More.\n{\n}\n';
    const out = setTopLevel(template, 'editor.tabSize', 4);
    expect(out.startsWith('// User settings.\n// More.\n{')).toBe(true);
    expect(valueOf(out)).toEqual({ 'editor.tabSize': 4 });
  });

  it('adds an object after the comments of a comment-only file', () => {
    const out = setTopLevel('// only a comment\n', 'editor.minimap', false);
    expect(out.startsWith('// only a comment\n')).toBe(true);
    expect(valueOf(out)).toEqual({ 'editor.minimap': false });
  });

  it('replaces a value in place and keeps comments and trailing commas', () => {
    const text = [
      '{',
      '  // size of the font',
      '  "editor.fontSize": 12, // keep this small',
      '  "editor.minimap": false,',
      '}',
      '',
    ].join('\n');
    const out = setTopLevel(text, 'editor.fontSize', 16);
    expect(out).toBe(text.replace('12', '16'));
  });

  it('appends a new key after existing entries without disturbing comments', () => {
    const text = '{\n  // the theme\n  "appearance.theme": "dark", // preferred\n}\n';
    const out = setTopLevel(text, 'editor.fontSize', 15);
    expect(out).toContain('// the theme');
    expect(out).toContain('// preferred');
    expect(valueOf(out)).toEqual({ 'appearance.theme': 'dark', 'editor.fontSize': 15 });
  });

  it('keeps CRLF line endings', () => {
    const text = '{\r\n  "a.b": 1\r\n}\r\n';
    const out = setTopLevel(text, 'c.d', 2);
    expect(detectEol(out)).toBe('\r\n');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(valueOf(out)).toEqual({ 'a.b': 1, 'c.d': 2 });
  });

  it('keeps tab indentation', () => {
    const out = setTopLevel('{\n\t"a.b": 1\n}\n', 'c.d', { x: true });
    expect(out).toContain('\t"c.d": {\n\t\t"x": true\n\t}');
  });

  it('matches the indentation width already in the file', () => {
    const out = setTopLevel('{\n    "a.b": 1\n}\n', 'c.d', 2);
    expect(out).toContain('\n    "c.d": 2');
  });

  it('writes lists and objects as JSON values', () => {
    let text = setTopLevel('{\n}\n', 'editor.rulers', [80, 100]);
    text = setTopLevel(text, 'files.exclude', { '**/dist': true });
    expect(valueOf(text)).toEqual({
      'editor.rulers': [80, 100],
      'files.exclude': { '**/dist': true },
    });
  });

  it('collapses duplicate keys into one entry with the new value', () => {
    const out = setTopLevel('{\n  "a.b": 1,\n  "x": 0,\n  "a.b": 2\n}\n', 'a.b', 3);
    expect(valueOf(out)).toEqual({ 'a.b': 3, x: 0 });
    expect(out.match(/"a\.b"/g)).toHaveLength(1);
  });

  it('handles a single-line document', () => {
    const out = setTopLevel('{"a.b":1}', 'a.b', 2);
    expect(out).toBe('{"a.b":2}');
  });

  it('is stable: setting the same value changes nothing', () => {
    const text = '{\n  "a.b": 1, // note\n}\n';
    expect(setTopLevel(text, 'a.b', 1)).toBe(text);
  });
});

describe('removeTopLevel', () => {
  it('removes a middle entry and its comma', () => {
    const out = removeTopLevel('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n', 'b');
    expect(out).toBe('{\n  "a": 1,\n  "c": 3\n}\n');
  });

  it('removes the last entry and the comma before it', () => {
    const out = removeTopLevel('{\n  "a": 1,\n  "b": 2\n}\n', 'b');
    expect(out).toBe('{\n  "a": 1\n}\n');
  });

  it('removes an entry that has a trailing comma and a trailing comment', () => {
    const out = removeTopLevel('{\n  // c\n  "a": 1, // x\n}\n', 'a');
    expect(valueOf(out)).toEqual({});
    expect(out).toContain('// c');
  });

  it('removes the only entry and leaves a valid empty object', () => {
    const out = removeTopLevel('// h\n{\n  "a": 1\n}\n', 'a');
    expect(out).toBe('// h\n{\n}\n');
  });

  it('removes the last entry when the previous one is followed by a comment', () => {
    const out = removeTopLevel('{\n  "a": 1, // first\n  "b": 2\n}\n', 'b');
    expect(valueOf(out)).toEqual({ a: 1 });
    expect(out).toContain('// first');
  });

  it('removes entries on a single line', () => {
    expect(removeTopLevel('{ "a": 1, "b": 2 }', 'a')).toBe('{ "b": 2 }');
    expect(valueOf(removeTopLevel('{ "a": 1, "b": 2 }', 'b'))).toEqual({ a: 1 });
  });

  it('removes every duplicate of the key', () => {
    const out = removeTopLevel('{\n  "a": 1,\n  "b": 0,\n  "a": 2,\n}\n', 'a');
    expect(valueOf(out)).toEqual({ b: 0 });
  });

  it('keeps CRLF line endings when removing', () => {
    const out = removeTopLevel('{\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n', 'a');
    expect(out).toBe('{\r\n  "b": 2\r\n}\r\n');
  });

  it('returns the text unchanged when the key is absent or the root is not an object', () => {
    const text = '{\n  "a": 1\n}\n';
    expect(removeTopLevel(text, 'zzz')).toBe(text);
    expect(removeTopLevel('[1, 2]', 'a')).toBe('[1, 2]');
    expect(removeTopLevel('', 'a')).toBe('');
  });

  it('does not touch nested properties with the same name', () => {
    const text = '{\n  "outer": { "a": 1 },\n  "a": 2\n}\n';
    expect(valueOf(removeTopLevel(text, 'a'))).toEqual({ outer: { a: 1 } });
  });
});
