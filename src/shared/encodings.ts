/** Text encodings .inc can read and write. Ids are stable and stored in settings and sessions. */
export type TextEncoding =
  | 'utf8'
  | 'utf8bom'
  | 'utf16le'
  | 'utf16be'
  | 'windows1252'
  | 'iso88591'
  | 'windows1251'
  | 'koi8r'
  | 'shiftjis'
  | 'eucjp'
  | 'gbk'
  | 'big5'
  | 'euckr';

export interface EncodingInfo {
  id: TextEncoding;
  /** Label shown in the status bar and pickers. */
  label: string;
  /** Name understood by iconv-lite. */
  iconv: string;
  /** Byte order mark written/expected, if any. */
  bom?: number[];
}

export const ENCODINGS: readonly EncodingInfo[] = [
  { id: 'utf8', label: 'UTF-8', iconv: 'utf8' },
  { id: 'utf8bom', label: 'UTF-8 with BOM', iconv: 'utf8', bom: [0xef, 0xbb, 0xbf] },
  { id: 'utf16le', label: 'UTF-16 LE', iconv: 'utf16le', bom: [0xff, 0xfe] },
  { id: 'utf16be', label: 'UTF-16 BE', iconv: 'utf16-be', bom: [0xfe, 0xff] },
  { id: 'windows1252', label: 'Windows 1252', iconv: 'windows-1252' },
  { id: 'iso88591', label: 'ISO 8859-1', iconv: 'iso-8859-1' },
  { id: 'windows1251', label: 'Windows 1251 (Cyrillic)', iconv: 'windows-1251' },
  { id: 'koi8r', label: 'KOI8-R (Cyrillic)', iconv: 'koi8-r' },
  { id: 'shiftjis', label: 'Shift JIS', iconv: 'shift_jis' },
  { id: 'eucjp', label: 'EUC-JP', iconv: 'euc-jp' },
  { id: 'gbk', label: 'GBK (Simplified Chinese)', iconv: 'gbk' },
  { id: 'big5', label: 'Big5 (Traditional Chinese)', iconv: 'big5' },
  { id: 'euckr', label: 'EUC-KR', iconv: 'euc-kr' },
];

export function encodingInfo(id: TextEncoding): EncodingInfo {
  return ENCODINGS.find((e) => e.id === id) ?? (ENCODINGS[0] as EncodingInfo);
}

export type EndOfLine = 'lf' | 'crlf';
