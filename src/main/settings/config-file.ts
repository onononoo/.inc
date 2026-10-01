import type { SettingsIssue } from '@shared/api/settings';
import { readConfigText } from './fs-util';

export interface ParsedConfig {
  issues: SettingsIssue[];
  /** True when the text could not be parsed; the previous good content stays in effect. */
  syntaxError: boolean;
}

/**
 * The in-memory state of one JSONC configuration file. A file that cannot be read or parsed keeps
 * its last good content (so half-typed edits never reset the user's configuration) and reports
 * the problem as an issue.
 */
export class ConfigFile<P extends ParsedConfig> {
  private key = '\u0000unloaded';
  private good: P;
  private latest: P;

  constructor(
    readonly file: string,
    private readonly parse: (text: string | null, file: string) => P,
  ) {
    this.good = parse(null, file);
    this.latest = this.good;
  }

  /** Current content: the last good parse, with the issues of the latest attempt. */
  get value(): P {
    if (this.latest === this.good) return this.good;
    return { ...this.good, issues: this.latest.issues, syntaxError: true };
  }

  /** Re-read the file from disk. Returns whether anything changed. */
  load(): boolean {
    const read = readConfigText(this.file);
    if (read.kind === 'ok') return this.apply(read.text);
    if (read.kind === 'missing') return this.apply(null);
    const key = `error:${read.message}`;
    if (key === this.key) return false;
    this.key = key;
    this.latest = {
      ...this.good,
      syntaxError: true,
      issues: [{ file: this.file, message: `This file could not be read: ${read.message}` }],
    };
    return true;
  }

  /** Adopt text that was just written by this process. */
  apply(text: string | null): boolean {
    const key = text === null ? '\u0000missing' : `text:${text}`;
    if (key === this.key) return false;
    this.key = key;
    const parsed = this.parse(text, this.file);
    this.latest = parsed;
    if (!parsed.syntaxError) this.good = parsed;
    return true;
  }
}
