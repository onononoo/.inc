import { Buffer, isUtf8 } from 'node:buffer';
import iconv from 'iconv-lite';
import { detect as detectCharset } from 'jschardet';
import { encodingInfo, type EndOfLine, type TextEncoding } from '@shared/encodings';
import { IncError } from '@shared/errors';

/** Number of leading bytes inspected to decide whether a file is binary. */
export const BINARY_SNIFF_BYTES = 8192;

/** Below this jschardet confidence the guess is ignored and Windows 1252 is used. */
const MIN_CONFIDENCE = 0.3;

/** Names reported by the detector, normalised to lower case without punctuation. */
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

/** Encoding implied by a byte order mark at the start of `buf`, if any. */
export function detectBom(buf: Uint8Array): TextEncoding | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf8bom';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf16be';
  return null;
}

function bomLength(encoding: TextEncoding): number {
  return encodingInfo(encoding).bom?.length ?? 0;
}

function hasBom(buf: Uint8Array, encoding: TextEncoding): boolean {
  const bom = encodingInfo(encoding).bom;
  return !!bom && buf.length >= bom.length && bom.every((byte, i) => buf[i] === byte);
}

/**
 * A file is binary when its first 8 KB contain a NUL byte, unless it starts with a UTF-16 byte
 * order mark (UTF-16 text is full of NULs).
 */
export function looksBinary(head: Uint8Array): boolean {
  const bom = detectBom(head);
  if (bom === 'utf16le' || bom === 'utf16be') return false;
  const end = Math.min(head.length, BINARY_SNIFF_BYTES);
  return head.subarray(0, end).includes(0);
}

function decodeLegacy(buf: Uint8Array, encoding: TextEncoding): string {
  return iconv.decode(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), encodingInfo(encoding).iconv, {
    stripBOM: false,
  });
}

/**
 * Decode `buf` as `encoding`. A byte order mark that matches the encoding is removed; it is
 * written back by `encodeText`.
 */
export function decodeBuffer(buf: Uint8Array, encoding: TextEncoding): string {
  const start = hasBom(buf, encoding) ? bomLength(encoding) : 0;
  const view = Buffer.from(buf.buffer, buf.byteOffset + start, buf.byteLength - start);
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

/**
 * Pick the encoding of a file's bytes: byte order marks first, then strict UTF-8 validation, then
 * statistical detection for legacy code pages, and finally Windows 1252 (ISO 8859-1 when
 * Windows 1252 cannot represent every byte).
 */
export function detectEncoding(buf: Uint8Array): TextEncoding {
  const bom = detectBom(buf);
  if (bom) return bom;
  if (buf.length === 0 || isUtf8(buf)) return 'utf8';

  let guess: TextEncoding = 'windows1252';
  try {
    const result = detectCharset(buf);
    if (result.encoding && result.confidence >= MIN_CONFIDENCE) {
      const key = result.encoding.toLowerCase().replace(/[^a-z0-9]/g, '');
      guess = DETECTED[key] ?? 'windows1252';
    }
  } catch {
    guess = 'windows1252';
  }
  if (guess === 'windows1252' && decodeLegacy(buf, guess).includes('\ufffd')) return 'iso88591';
  return guess;
}

/** Dominant line ending and whether both styles occur. A file without line breaks reports 'lf'. */
export function detectEol(text: string): { eol: EndOfLine; mixed: boolean } {
  let crlf = 0;
  let lf = 0;
  let at = text.indexOf('\n');
  while (at !== -1) {
    if (at > 0 && text.charCodeAt(at - 1) === 13) crlf++;
    else lf++;
    at = text.indexOf('\n', at + 1);
  }
  return { eol: crlf > lf ? 'crlf' : 'lf', mixed: crlf > 0 && lf > 0 };
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Encode text for writing, adding the byte order mark the encoding calls for. Throws E_INVALID
 * instead of silently replacing characters that the target code page cannot represent.
 */
export function encodeText(content: string, encoding: TextEncoding): Buffer {
  const info = encodingInfo(encoding);
  const bom = info.bom ? Buffer.from(info.bom) : null;
  let body: Buffer;
  switch (encoding) {
    case 'utf8':
    case 'utf8bom':
      body = Buffer.from(content, 'utf8');
      break;
    case 'utf16le':
      body = Buffer.from(content, 'utf16le');
      break;
    default:
      body = iconv.encode(content, info.iconv, { addBOM: false });
      if (!ASCII_ONLY.test(content) && iconv.decode(body, info.iconv, { stripBOM: false }) !== content) {
        throw new IncError(
          'E_INVALID',
          `Some characters cannot be saved as ${info.label}. Save the file as UTF-8 instead.`,
          { encoding },
        );
      }
  }
  return bom ? Buffer.concat([bom, body]) : body;
}
