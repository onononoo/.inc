import { Buffer, isUtf8 } from 'node:buffer';
import iconv from 'iconv-lite';
import { detect as detectCharset } from 'jschardet';

/** Git treats content as binary when a NUL byte appears in its first 8000 bytes. */
export const BINARY_SNIFF_BYTES = 8000;

/** Below this jschardet confidence the guess is ignored and Windows 1252 is used. */
const MIN_CONFIDENCE = 0.3;
const DETECT_SAMPLE_BYTES = 64 * 1024;

const hasPrefix = (buf: Uint8Array, bytes: number[]) =>
  buf.length >= bytes.length && bytes.every((byte, i) => buf[i] === byte);

function startsWithUtf16Bom(buf: Uint8Array): 'le' | 'be' | null {
  if (hasPrefix(buf, [0xff, 0xfe])) return 'le';
  if (hasPrefix(buf, [0xfe, 0xff])) return 'be';
  return null;
}

/** True when the first 8000 bytes contain a NUL, except for UTF-16 text (which is full of them). */
export function isBinaryContent(buf: Uint8Array): boolean {
  if (startsWithUtf16Bom(buf)) return false;
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * Decode stored file content to text. UTF-8 (the norm) is decoded directly; UTF-16 with a byte
 * order mark and legacy encodings are detected and converted so the diff never shows mojibake.
 * A leading byte order mark is dropped, as it is when a file is opened in the editor.
 */
export function decodeBlobText(buf: Buffer): string {
  const utf16 = startsWithUtf16Bom(buf);
  if (utf16 === 'le') return buf.subarray(2).toString('utf16le');
  if (utf16 === 'be') return iconv.decode(buf.subarray(2), 'utf16-be');

  const start = hasPrefix(buf, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  const body = buf.subarray(start);
  if (isUtf8(body)) return body.toString('utf8');

  const guess = detectCharset(body.subarray(0, DETECT_SAMPLE_BYTES));
  const encoding =
    guess && guess.confidence >= MIN_CONFIDENCE && iconv.encodingExists(guess.encoding)
      ? guess.encoding
      : 'windows-1252';
  return iconv.decode(body, encoding);
}
