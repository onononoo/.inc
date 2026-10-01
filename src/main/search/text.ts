/**
 * Reading file bytes as text: binary detection, encoding detection and conversion, and line
 * iteration. Used by the search workers; has no dependency on Electron.
 */
import { Buffer, isUtf8 } from 'node:buffer';
import iconv from 'iconv-lite';
import { detect as detectCharset } from 'jschardet';
import { encodingInfo, type TextEncoding } from '@shared/encodings';
import { BINARY_SNIFF_BYTES } from './protocol';

/** Bytes handed to the statistical detector; enough to be reliable and cheap on large files. */
const DETECT_SAMPLE_BYTES = 64 * 1024;

/** Below this confidence the detector's guess is ignored. */
const MIN_CONFIDENCE = 0.3;

const DETECTED: Record<string, TextEncoding> = {
  windows1252: 'windows1252',
  iso88591: 'iso88591',
  windows1251: 'windows1251',
  koi8r: 'koi8r',
  shiftjis: 'shiftjis',
  cp932: 'shiftjis',
  eucjp: 'eucjp',
  gbk: 'gbk',
  gb2312: 'gbk',
  gb18030: 'gbk',
  big5: 'big5',
  euckr: 'euckr',
  cp949: 'euckr',
};

export function detectBom(buf: Uint8Array): TextEncoding | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8bom';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  return null;
}

/**
 * A file is binary when its first 8 KB contain a NUL byte, unless it starts with a UTF-16 byte
 * order mark (UTF-16 text is full of NUL bytes).
 */
export function looksBinary(buf: Uint8Array, length = buf.length): boolean {
  const bom = detectBom(buf);
  if (bom === 'utf16le' || bom === 'utf16be') return false;
  return buf.subarray(0, Math.min(length, BINARY_SNIFF_BYTES)).includes(0);
}

function toBuffer(buf: Uint8Array, start = 0): Buffer {
  return Buffer.from(buf.buffer, buf.byteOffset + start, buf.byteLength - start);
}

function decodeLegacy(buf: Uint8Array, encoding: TextEncoding): string {
  return iconv.decode(toBuffer(buf), encodingInfo(encoding).iconv, { stripBOM: false });
}

/** Number of bytes the byte order mark of `encoding` occupies at the start of `buf`. */
export function bomLength(buf: Uint8Array, encoding: TextEncoding): number {
  const bom = encodingInfo(encoding).bom;
  return bom && buf.length >= bom.length && bom.every((byte, i) => buf[i] === byte)
    ? bom.length
    : 0;
}

/**
 * Pick an encoding for the bytes: byte order marks, then strict UTF-8, then the statistical
 * detector for legacy code pages, and finally Windows 1252 (ISO 8859-1 when Windows 1252 has no
 * character for some byte).
 */
export function detectEncoding(buf: Uint8Array): TextEncoding {
  const bom = detectBom(buf);
  if (bom) return bom;
  if (buf.length === 0 || isUtf8(buf)) return 'utf8';

  let guess: TextEncoding = 'windows1252';
  try {
    const sample = buf.subarray(0, DETECT_SAMPLE_BYTES);
    const result = detectCharset(toBuffer(sample));
    if (result.encoding && result.confidence >= MIN_CONFIDENCE) {
      const key = result.encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
      guess = DETECTED[key] ?? 'windows1252';
    }
  } catch {
    guess = 'windows1252';
  }
  if (guess === 'windows1252' && decodeLegacy(buf, guess).includes('�')) return 'iso88591';
  return guess;
}

/** Decode `buf` as `encoding`, dropping a byte order mark that belongs to it. */
export function decodeText(buf: Uint8Array, encoding: TextEncoding): string {
  const view = toBuffer(buf, bomLength(buf, encoding));
  switch (encoding) {
    case 'utf8':
    case 'utf8bom':
      return view.toString('utf8');
    case 'utf16le':
      return view.toString('utf16le');
    default:
      return decodeLegacy(view, encoding);
  }
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Encode text for writing back to a file, with the byte order mark the encoding calls for.
 * Throws when a legacy code page cannot represent some character.
 */
export function encodeText(text: string, encoding: TextEncoding): Buffer {
  const info = encodingInfo(encoding);
  const bom = info.bom ? Buffer.from(info.bom) : null;
  let body: Buffer;
  switch (encoding) {
    case 'utf8':
    case 'utf8bom':
      body = Buffer.from(text, 'utf8');
      break;
    case 'utf16le':
      body = Buffer.from(text, 'utf16le');
      break;
    default:
      body = iconv.encode(text, info.iconv, { addBOM: false });
      if (
        !ASCII_ONLY.test(text) &&
        iconv.decode(body, info.iconv, { stripBOM: false }) !== text
      ) {
        throw new Error(`Some characters cannot be saved as ${info.label}.`);
      }
  }
  return bom ? Buffer.concat([bom, body]) : body;
}

/** The dominant line ending of a text; LF when it has none. */
export function dominantEol(text: string): '\n' | '\r\n' {
  let crlf = 0;
  let lf = 0;
  let at = text.indexOf('\n');
  while (at !== -1) {
    if (at > 0 && text.charCodeAt(at - 1) === 13) crlf++;
    else lf++;
    at = text.indexOf('\n', at + 1);
  }
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Call `visit` for every line of `text`. Lines end at "\r\n", "\n" or a lone "\r" (the same
 * rule the editor uses, so line numbers agree). `start..end` is the line without its terminator
 * and `next` is where the following line starts. Returning `false` stops the iteration.
 */
export function forEachLine(
  text: string,
  visit: (start: number, end: number, lineNumber: number, next: number) => boolean | void,
): void {
  const length = text.length;
  let pos = 0;
  let lineNumber = 1;
  let lf = text.indexOf('\n');
  let cr = text.indexOf('\r');
  for (;;) {
    let end: number;
    let next: number;
    if (cr !== -1 && (lf === -1 || cr < lf)) {
      end = cr;
      next = cr + 1 === lf ? cr + 2 : cr + 1;
    } else if (lf !== -1) {
      end = lf;
      next = lf + 1;
    } else {
      end = length;
      next = length;
    }
    if (visit(pos, end, lineNumber, next) === false) return;
    if (end === length && next === length) return;
    pos = next;
    lineNumber++;
    if (lf !== -1 && lf < pos) lf = text.indexOf('\n', pos);
    if (cr !== -1 && cr < pos) cr = text.indexOf('\r', pos);
  }
}
