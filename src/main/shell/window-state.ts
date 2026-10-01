/**
 * Window placement: what is persisted, how it is validated against the displays that are
 * connected right now, and where additional windows go. Pure: displays are passed in.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SavedWindowState extends Rect {
  maximized: boolean;
  fullscreen: boolean;
}

export interface SavedTheme {
  scheme: 'light' | 'dark';
  /** `#rrggbb` */
  background: string;
  /** `#rrggbb` */
  foreground: string;
}

/** Contents of userData/window-state.json. */
export interface PersistedShellState {
  version: 1;
  window: SavedWindowState | null;
  theme: SavedTheme | null;
}

export const MIN_WINDOW = { width: 720, height: 480 } as const;
export const DEFAULT_WINDOW = { width: 1280, height: 800 } as const;
/** Offset of each extra window from the one it was opened from. */
export const CASCADE_OFFSET = 30;
/** At least this much of a window must overlap a display for the saved position to be trusted. */
const MIN_VISIBLE = { width: 120, height: 60 } as const;

export const EMPTY_SHELL_STATE: PersistedShellState = { version: 1, window: null, theme: null };

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** Reads the state file. Anything malformed is dropped field by field, never fatal. */
export function parsePersistedState(raw: string): PersistedShellState {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ...EMPTY_SHELL_STATE };
  }
  if (typeof data !== 'object' || data === null) return { ...EMPTY_SHELL_STATE };
  const record = data as Record<string, unknown>;

  let window: SavedWindowState | null = null;
  const w = record.window;
  if (typeof w === 'object' && w !== null) {
    const r = w as Record<string, unknown>;
    if (
      isInt(r.x, -100_000, 100_000) &&
      isInt(r.y, -100_000, 100_000) &&
      isInt(r.width, 1, 100_000) &&
      isInt(r.height, 1, 100_000)
    ) {
      window = {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        maximized: r.maximized === true,
        fullscreen: r.fullscreen === true,
      };
    }
  }

  let theme: SavedTheme | null = null;
  const t = record.theme;
  if (typeof t === 'object' && t !== null) {
    const r = t as Record<string, unknown>;
    if (
      (r.scheme === 'light' || r.scheme === 'dark') &&
      typeof r.background === 'string' &&
      HEX_COLOR.test(r.background) &&
      typeof r.foreground === 'string' &&
      HEX_COLOR.test(r.foreground)
    ) {
      theme = { scheme: r.scheme, background: r.background, foreground: r.foreground };
    }
  }
  return { version: 1, window, theme };
}

function intersectionArea(a: Rect, b: Rect): { width: number; height: number } {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return { width: Math.max(0, width), height: Math.max(0, height) };
}

export interface PlacementInput {
  /** Persisted state of the previous session, if any. */
  saved: SavedWindowState | null;
  /** Normal (not maximized) bounds of the window this one is opened from; makes it cascade. */
  cascadeFrom: Rect | null;
  /** Work areas of every connected display. */
  displays: readonly Rect[];
  /** Work area of the primary display. */
  primary: Rect;
}

export interface Placement extends Rect {
  maximized: boolean;
  fullscreen: boolean;
}

function fit(rect: Rect, area: Rect): Rect {
  const width = Math.min(Math.max(rect.width, MIN_WINDOW.width), Math.max(area.width, 1));
  const height = Math.min(Math.max(rect.height, MIN_WINDOW.height), Math.max(area.height, 1));
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height);
  return { x, y, width, height };
}

function centered(size: { width: number; height: number }, area: Rect): Rect {
  const width = Math.min(Math.max(size.width, MIN_WINDOW.width), Math.max(area.width, 1));
  const height = Math.min(Math.max(size.height, MIN_WINDOW.height), Math.max(area.height, 1));
  return {
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2),
    width,
    height,
  };
}

function bestDisplay(rect: Rect, displays: readonly Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestScore = 0;
  for (const display of displays) {
    const overlap = intersectionArea(rect, display);
    if (overlap.width < MIN_VISIBLE.width || overlap.height < MIN_VISIBLE.height) continue;
    const score = overlap.width * overlap.height;
    if (score > bestScore) {
      best = display;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Decide where a new window opens. A saved position survives only while enough of it is still on
 * a connected display (monitors get unplugged); otherwise the window is centred on the primary
 * display. Extra windows cascade from their parent and wrap back to the corner at the edge.
 */
export function resolvePlacement(input: PlacementInput): Placement {
  const { saved, cascadeFrom, displays, primary } = input;
  const areas = displays.length > 0 ? displays : [primary];

  if (cascadeFrom) {
    const area = bestDisplay(cascadeFrom, areas) ?? primary;
    const width = Math.min(Math.max(cascadeFrom.width, MIN_WINDOW.width), area.width);
    const height = Math.min(Math.max(cascadeFrom.height, MIN_WINDOW.height), area.height);
    let x = cascadeFrom.x + CASCADE_OFFSET;
    let y = cascadeFrom.y + CASCADE_OFFSET;
    if (x + width > area.x + area.width || y + height > area.y + area.height) {
      x = area.x + CASCADE_OFFSET;
      y = area.y + CASCADE_OFFSET;
    }
    return { ...fit({ x, y, width, height }, area), maximized: false, fullscreen: false };
  }

  if (saved) {
    const area = bestDisplay(saved, areas);
    if (area) return { ...fit(saved, area), maximized: saved.maximized, fullscreen: saved.fullscreen };
    return {
      ...centered(saved, primary),
      maximized: saved.maximized,
      fullscreen: saved.fullscreen,
    };
  }

  return { ...centered(DEFAULT_WINDOW, primary), maximized: false, fullscreen: false };
}
