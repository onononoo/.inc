/** Pure size arithmetic for the Splitter component. */

export function clampSize(size: number, min: number, max: number): number {
  const hi = Math.max(min, max);
  if (!Number.isFinite(size)) return min;
  return Math.round(Math.min(Math.max(size, min), hi));
}

/**
 * Size after dragging the splitter by `delta` pixels from `start`.
 * `invert` is true when the resized pane sits after the bar (a bottom panel: dragging up grows it).
 */
export function dragSize(
  start: number,
  delta: number,
  min: number,
  max: number,
  invert: boolean,
): number {
  return clampSize(start + (invert ? -delta : delta), min, max);
}

export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 64;

export type SplitterOrientation = 'vertical' | 'horizontal';

/**
 * Size after a key press on the separator, or null when the key does nothing.
 * A vertical separator (between left and right panes) answers to Left and Right, a horizontal
 * one to Up and Down. Arrow keys move the bar in their direction, so with `invert` the effect
 * on the resized pane flips.
 */
export function keySize(
  key: string,
  shift: boolean,
  size: number,
  min: number,
  max: number,
  orientation: SplitterOrientation,
  invert: boolean,
  defaultSize: number,
): number | null {
  const step = shift ? KEY_STEP_LARGE : KEY_STEP;
  const grow = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
  const shrink = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
  let direction = 0;
  if (key === grow) direction = 1;
  else if (key === shrink) direction = -1;
  else if (key === 'Home') return clampSize(min, min, max);
  else if (key === 'End') return clampSize(max, min, max);
  else if (key === 'Enter') return clampSize(defaultSize, min, max);
  else return null;
  return clampSize(size + (invert ? -direction : direction) * step, min, max);
}
