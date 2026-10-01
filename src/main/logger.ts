import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from './kernel';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;

function rotate(file: string): void {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* no log yet, or rotation raced with another instance */
  }
}

/** Size-rotated file logger. Never throws. Logs contain no file contents. */
export function createLogger(logDir: string, name = 'main'): Logger {
  const file = path.join(logDir, `${name}.log`);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    rotate(file);
  } catch {
    /* logging is best effort */
  }
  const write = (level: string, message: string, meta: unknown[]) => {
    const extra = meta.length
      ? ' ' + meta.map((m) => (m instanceof Error ? (m.stack ?? m.message) : safeJson(m))).join(' ')
      : '';
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${message}${extra}\n`;
    try {
      fs.appendFileSync(file, line);
    } catch {
      /* ignore */
    }
    if (process.env.INC_LOG_STDOUT === '1') process.stdout.write(line);
  };
  return {
    debug: (m, ...meta) => write('DEBUG', m, meta),
    info: (m, ...meta) => write('INFO', m, meta),
    warn: (m, ...meta) => write('WARN', m, meta),
    error: (m, ...meta) => write('ERROR', m, meta),
  };
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}
