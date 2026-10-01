import { describe, expect, it } from 'vitest';
import { expandReplacement, replaceOne } from '../../../src/renderer/search/replace';

describe('expandReplacement', () => {
  const groups = ['name: Ada', 'Ada', undefined];

  it('expands $1, $& and $$', () => {
    expect(expandReplacement('$1!', groups)).toBe('Ada!');
    expect(expandReplacement('<$&>', groups)).toBe('<name: Ada>');
    expect(expandReplacement('cost $$5', groups)).toBe('cost $5');
  });

  it('treats a missing or empty group as nothing and an unknown group literally', () => {
    expect(expandReplacement('[$2]', groups)).toBe('[]');
    expect(expandReplacement('$9', groups)).toBe('$9');
    expect(expandReplacement('$0', groups)).toBe('$0');
  });

  it('prefers a two-digit group only when it exists', () => {
    const many = ['all', ...Array.from({ length: 12 }, (_, i) => `g${i + 1}`)];
    expect(expandReplacement('$12', many)).toBe('g12');
    expect(expandReplacement('$12', ['all', 'one'])).toBe('one2');
  });

  it('leaves a trailing dollar and ordinary text alone', () => {
    expect(expandReplacement('plain', groups)).toBe('plain');
    expect(expandReplacement('end$', groups)).toBe('end$');
    expect(expandReplacement('', groups)).toBe('');
  });
});

describe('replaceOne', () => {
  it('replaces exactly one match by line and column', () => {
    const text = 'foo bar\nbar foo\nfoo';
    expect(
      replaceOne(text, { line: 2, column: 5, length: 3 }, { replacement: 'X', matchedText: 'foo' }),
    ).toBe('foo bar\nbar X\nfoo');
  });

  it('keeps every line ending as it was', () => {
    const text = 'a foo\r\nb foo\nc foo\rd';
    expect(replaceOne(text, { line: 1, column: 3, length: 3 }, { replacement: 'X' })).toBe(
      'a X\r\nb foo\nc foo\rd',
    );
    expect(replaceOne(text, { line: 3, column: 3, length: 3 }, { replacement: 'X' })).toBe(
      'a foo\r\nb foo\nc X\rd',
    );
    expect(replaceOne(text, { line: 4, column: 1, length: 1 }, { replacement: 'Z' })).toBe(
      'a foo\r\nb foo\nc foo\rZ',
    );
  });

  it('refuses when the text at the position changed since the search', () => {
    expect(
      replaceOne(
        'foo',
        { line: 1, column: 1, length: 3 },
        { replacement: 'X', matchedText: 'bar' },
      ),
    ).toBeNull();
    expect(replaceOne('foo', { line: 5, column: 1, length: 3 }, { replacement: 'X' })).toBeNull();
    expect(replaceOne('foo', { line: 1, column: 2, length: 9 }, { replacement: 'X' })).toBeNull();
  });

  it('expands capture groups for a regular expression', () => {
    const regex = /(\w+)@(\w+)\.com/g;
    expect(
      replaceOne(
        'mail ada@example.com now',
        { line: 1, column: 6, length: 15 },
        { replacement: '$2:$1', regex },
      ),
    ).toBe('mail example:ada now');
  });

  it('counts astral characters in UTF-16 code units', () => {
    const text = '\u{1F600} needle';
    expect(
      replaceOne(
        text,
        { line: 1, column: 4, length: 6 },
        { replacement: 'pin', matchedText: 'needle' },
      ),
    ).toBe('\u{1F600} pin');
  });
});
