/**
 * Line editing for the pipe fallback.
 *
 * A real terminal device echoes typed characters, handles backspace and turns Enter into a line
 * for the shell. A shell connected through pipes gets none of that, so this class does it: it
 * collects typed characters into a line, produces the echo to show, and reports completed lines
 * to write to the shell's standard input. Cursor keys and other escape sequences are ignored
 * (there is no history or in-line cursor movement in fallback mode).
 */

export interface LineInputResult {
  /** Text to display immediately. */
  echo: string;
  /** Complete lines, without line terminators. */
  lines: string[];
  /** Ctrl+D on an empty line: close the shell's standard input. */
  endOfInput: boolean;
}

type EscapeState = 'none' | 'escape' | 'csi' | 'ss3';

export class LineDiscipline {
  private buffer: string[] = [];
  private escape: EscapeState = 'none';
  private afterCarriageReturn = false;

  input(data: string): LineInputResult {
    let echo = '';
    const lines: string[] = [];
    let endOfInput = false;

    for (const char of data) {
      const code = char.codePointAt(0) ?? 0;

      if (this.escape !== 'none') {
        if (this.escape === 'escape') {
          if (char === '[') this.escape = 'csi';
          else if (char === 'O') this.escape = 'ss3';
          else this.escape = 'none';
        } else if (this.escape === 'csi') {
          // Parameter and intermediate bytes continue; a final byte (0x40-0x7e) ends the sequence.
          if (code >= 0x40 && code <= 0x7e) this.escape = 'none';
        } else {
          this.escape = 'none';
        }
        continue;
      }

      if (char === '\n' && this.afterCarriageReturn) {
        this.afterCarriageReturn = false;
        continue;
      }
      this.afterCarriageReturn = char === '\r';

      if (char === '\r' || char === '\n') {
        echo += '\r\n';
        lines.push(this.buffer.join(''));
        this.buffer = [];
      } else if (char === '\u007f' || char === '\b') {
        if (this.buffer.pop() !== undefined) echo += '\b \b';
      } else if (char === '\u0003') {
        echo += '^C\r\n';
        this.buffer = [];
      } else if (char === '\u0004') {
        if (this.buffer.length === 0) endOfInput = true;
      } else if (char === '\u0015') {
        echo += '\b \b'.repeat(this.buffer.length);
        this.buffer = [];
      } else if (char === '\u001b') {
        this.escape = 'escape';
      } else if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
        this.buffer.push(char);
        echo += char;
      }
    }
    return { echo, lines, endOfInput };
  }
}

/** Converts the line endings a pipe produces ("\n") to what a terminal display expects ("\r\n"). */
export class NewlineTranslator {
  private afterCarriageReturn = false;

  translate(chunk: string): string {
    if (chunk.length === 0) return chunk;
    let text = chunk;
    let prefix = '';
    if (this.afterCarriageReturn && text.startsWith('\n')) {
      prefix = '\n';
      text = text.slice(1);
    }
    this.afterCarriageReturn = chunk.endsWith('\r');
    return prefix + text.replace(/\r?\n/g, '\r\n');
  }
}
