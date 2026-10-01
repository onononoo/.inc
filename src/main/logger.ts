import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './kernel';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type Level = (typeof LEVELS)[number];

function rotate(file: string): void {
  try {
    for (let i = KEEP - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* no log yet, or rotation raced with another instance */
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One line per entry: control characters in messages cannot forge or split log lines. */
function oneLine(text: string): string {
  return (
    text
      .replace(/\r?\n/g, ' | ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  );
}

export interface LoggerOptions {
  /** Entries below this level are dropped. Defaults to INC_LOG_LEVEL, or "info". */
  level?: Level;
  maxBytes?: number;
}

function defaultLevel(): Level {
  const configured = process.env.INC_LOG_LEVEL;
  return (LEVELS as readonly string[]).includes(configured ?? '') ? (configured as Level) : 'info';
}

/**
 * Size-rotated file logger. Never throws. Logs contain no file contents. The current file rolls
 * over when it passes `maxBytes`, and three older files are kept.
 */
export function createLogger(logDir: string, name = 'main', options: LoggerOptions = {}): Logger {
  const file = path.join(logDir, `${name}.log`);
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const minimum = LEVELS.indexOf(options.level ?? defaultLevel());
  let size = 0;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    size = sizeOf(file);
    if (size >= maxBytes) {
      rotate(file);
      size = 0;
    }
  } catch {
    /* logging is best effort */
  }

  const write = (level: Level, message: string, meta: unknown[]) => {
    if (LEVELS.indexOf(level) < minimum) return;
    const extra = meta.length
      ? ' ' +
        meta.map((m) => oneLine(m instanceof Error ? (m.stack ?? m.message) : safeJson(m))).join(' ')
      : '';
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${oneLine(message)}${extra}\n`;
    try {
      if (size >= maxBytes) {
        rotate(file);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch {
      /* ignore */
    }
    if (process.env.INC_LOG_STDOUT === '1') process.stdout.write(line);
  };
  return {
    debug: (m, ...meta) => write('debug', m, meta),
    info: (m, ...meta) => write('info', m, meta),
    warn: (m, ...meta) => write('warn', m, meta),
    error: (m, ...meta) => write('error', m, meta),
  };
}
