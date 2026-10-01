/**
 * Converts the CSS colours the renderer reports (hex, rgb(), hsl()) into plain `#rrggbb`, the one
 * format every native window API accepts. Alpha is dropped: title bar overlays and window
 * backgrounds are opaque. Returns null for anything else.
 */

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function toHex(r: number, g: number, b: number): string {
  const part = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

function channel(token: string | undefined): number | null {
  if (token === undefined) return null;
  const percent = /^(-?\d*\.?\d+)%$/.exec(token);
  if (percent) return (Number(percent[1]) / 100) * 255;
  if (/^-?\d*\.?\d+$/.test(token)) return Number(token);
  return null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const f = (t: number) => {
    const x = (t + 1) % 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [f(hue + 1 / 3) * 255, f(hue) * 255, f(hue - 1 / 3) * 255];
}

export function normalizeCssColor(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > 64) return null;

  const hex = HEX.exec(text);
  if (hex) {
    const digits = hex[1] ?? '';
    if (digits.length <= 4) {
      const [r = '0', g = '0', b = '0'] = digits;
      return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
    }
    return `#${digits.slice(0, 6)}`.toLowerCase();
  }

  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/i.exec(text);
  if (!fn) return null;
  const kind = (fn[1] ?? '').toLowerCase();
  const tokens = (fn[2] ?? '').split(/[\s,/]+/).filter(Boolean);
  if (tokens.length < 3 || tokens.length > 4) return null;

  if (kind.startsWith('rgb')) {
    const r = channel(tokens[0]);
    const g = channel(tokens[1]);
    const b = channel(tokens[2]);
    if (r === null || g === null || b === null) return null;
    return toHex(r, g, b);
  }

  const hue = /^(-?\d*\.?\d+)(deg)?$/.exec(tokens[0] ?? '');
  const sat = /^(\d*\.?\d+)%$/.exec(tokens[1] ?? '');
  const lig = /^(\d*\.?\d+)%$/.exec(tokens[2] ?? '');
  if (!hue || !sat || !lig) return null;
  const [r, g, b] = hslToRgb(Number(hue[1]), Number(sat[1]) / 100, Number(lig[1]) / 100);
  return toHex(r, g, b);
}
