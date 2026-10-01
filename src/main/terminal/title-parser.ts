/**
 * Extracts window titles that a shell sets with the OSC 0 and OSC 2 escape sequences
 * (`ESC ] 0 ; title BEL` or `ESC ] 2 ; title ESC \`). The output itself is forwarded untouched;
 * this only observes it. Sequences split across chunks are handled.
 */

const MAX_TITLE = 256;
/** Longest unterminated sequence that is kept while waiting for the rest. */
const MAX_PENDING = 1_024;

const OSC = /\u001b\](?:0|2);([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
const OSC_START = '\u001b]';
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeTitle(raw: string): string {
  return raw.replace(CONTROL, '').trim().slice(0, MAX_TITLE);
}

export class TitleParser {
  private pending = '';
  private last: string | null = null;

  /** Feed a chunk of output. Returns each new title, in order. Unchanged titles are not repeated. */
  feed(chunk: string): string[] {
    const text = this.pending + chunk;
    this.pending = '';
    const titles: string[] = [];

    let consumed = 0;
    OSC.lastIndex = 0;
    for (let match = OSC.exec(text); match; match = OSC.exec(text)) {
      consumed = OSC.lastIndex;
      const title = sanitizeTitle(match[1] ?? '');
      if (title.length > 0 && title !== this.last) {
        this.last = title;
        titles.push(title);
      }
    }

    // Keep an unterminated sequence at the end for the next chunk.
    const tail = text.slice(consumed);
    const start = tail.lastIndexOf(OSC_START);
    if (start !== -1) {
      const candidate = tail.slice(start);
      const terminated = candidate.includes('\u0007') || candidate.includes('\u001b\\');
      if (candidate.length <= MAX_PENDING && !terminated) {
        this.pending = candidate;
      }
    } else if (tail.endsWith('\u001b')) {
      this.pending = '\u001b';
    }
    return titles;
  }
}
