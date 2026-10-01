import { describe, expect, it } from 'vitest';
import { LineDiscipline, NewlineTranslator } from '../../../src/main/terminal/line-discipline';

describe('LineDiscipline', () => {
  it('echoes typed characters and returns a line on Enter', () => {
    const d = new LineDiscipline();
    expect(d.input('ec')).toEqual({ echo: 'ec', lines: [], endOfInput: false });
    expect(d.input('ho hi\r')).toEqual({ echo: 'ho hi\r\n', lines: ['echo hi'], endOfInput: false });
  });

  it('treats CR LF as one Enter, even across chunks', () => {
    const d = new LineDiscipline();
    expect(d.input('a\r\nb\r').lines).toEqual(['a', 'b']);
    expect(d.input('c\r').lines).toEqual(['c']);
    expect(d.input('\n').lines).toEqual([]);
    expect(d.input('d\n').lines).toEqual(['d']);
  });

  it('returns empty lines for a bare Enter', () => {
    expect(new LineDiscipline().input('\r').lines).toEqual(['']);
  });

  it('handles several lines pasted at once', () => {
    expect(new LineDiscipline().input('one\rtwo\rthr').lines).toEqual(['one', 'two']);
  });

  it('erases with backspace and DEL, but not past the start of the line', () => {
    const d = new LineDiscipline();
    const result = d.input('abc\u007f\bx\u007f\u007f\u007f\u007fz\r');
    expect(result.lines).toEqual(['z']);
    expect(result.echo).toBe('abc\b \b\b \bx\b \b\b \b\b \bz\r\n');
  });

  it('clears the line on Ctrl+C and Ctrl+U', () => {
    const d = new LineDiscipline();
    expect(d.input('abc\u0003')).toMatchObject({ echo: 'abc^C\r\n', lines: [] });
    expect(d.input('xy\u0015z\r')).toMatchObject({ lines: ['z'] });
    expect(d.input('xy\u0015').echo).toBe('xy\b \b\b \b');
  });

  it('signals end of input with Ctrl+D only on an empty line', () => {
    const d = new LineDiscipline();
    expect(d.input('\u0004').endOfInput).toBe(true);
    expect(d.input('a\u0004').endOfInput).toBe(false);
  });

  it('ignores cursor keys and other escape sequences', () => {
    const d = new LineDiscipline();
    const result = d.input('a\u001b[A\u001b[1;5Cb\u001bOPc\u001bxd\r');
    expect(result.lines).toEqual(['abcd']);
    expect(result.echo).toBe('abcd\r\n');
  });

  it('keeps an escape sequence split across chunks together', () => {
    const d = new LineDiscipline();
    d.input('a\u001b');
    d.input('[');
    d.input('1;5');
    expect(d.input('Cb\r').lines).toEqual(['ab']);
  });

  it('ignores other control characters and keeps non-ASCII text', () => {
    const d = new LineDiscipline();
    expect(d.input('a\u0001\u0002\tb é中\u{1f600}\r').lines).toEqual(['ab é中\u{1f600}']);
  });
});

describe('NewlineTranslator', () => {
  it('converts bare line feeds without doubling carriage returns', () => {
    const t = new NewlineTranslator();
    expect(t.translate('a\nb\r\nc')).toBe('a\r\nb\r\nc');
  });

  it('keeps a CR LF pair that is split across chunks as one line break', () => {
    const t = new NewlineTranslator();
    expect(t.translate('line\r')).toBe('line\r');
    expect(t.translate('\nnext\n')).toBe('\nnext\r\n');
  });

  it('passes empty chunks through', () => {
    expect(new NewlineTranslator().translate('')).toBe('');
  });
});
