/** Pure placement maths shared by tooltips, menus and other floating surfaces. */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Box extends Point, Size {}

export type Placement = 'top' | 'bottom' | 'left' | 'right';

/** Distance kept between a floating surface and the edge of the viewport. */
export const VIEWPORT_MARGIN = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Places a context menu whose top-left corner should be at `point`. When it would overflow the
 * viewport it is shifted back inside, never leaving the viewport margin.
 */
export function placeAtPoint(point: Point, size: Size, viewport: Size): Point {
  const maxX = viewport.width - size.width - VIEWPORT_MARGIN;
  const maxY = viewport.height - size.height - VIEWPORT_MARGIN;
  return {
    x: clamp(point.x, VIEWPORT_MARGIN, maxX),
    y: clamp(point.y, VIEWPORT_MARGIN, maxY),
  };
}

/**
 * Places a submenu beside its parent item. It opens to the right, flips to the left when there is
 * no room, and is shifted vertically to stay inside the viewport.
 */
export function placeSubmenu(parent: Box, size: Size, viewport: Size, overlap = 2): Point {
  const rightX = parent.x + parent.width - overlap;
  const leftX = parent.x - size.width + overlap;
  const fitsRight = rightX + size.width + VIEWPORT_MARGIN <= viewport.width;
  const x = fitsRight || leftX < VIEWPORT_MARGIN ? rightX : leftX;
  // Align the first item of the submenu with the parent item (menu padding is 4px).
  const y = parent.y - 4;
  return placeAtPoint({ x, y }, size, viewport);
}

export interface FloatingPlacement extends Point {
  placement: Placement;
}

const OPPOSITE: Record<Placement, Placement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

function candidate(anchor: Box, size: Size, placement: Placement, gap: number): Point {
  switch (placement) {
    case 'top':
      return { x: anchor.x + anchor.width / 2 - size.width / 2, y: anchor.y - size.height - gap };
    case 'bottom':
      return { x: anchor.x + anchor.width / 2 - size.width / 2, y: anchor.y + anchor.height + gap };
    case 'left':
      return { x: anchor.x - size.width - gap, y: anchor.y + anchor.height / 2 - size.height / 2 };
    case 'right':
      return { x: anchor.x + anchor.width + gap, y: anchor.y + anchor.height / 2 - size.height / 2 };
  }
}

function fits(point: Point, size: Size, viewport: Size): boolean {
  return (
    point.x >= VIEWPORT_MARGIN &&
    point.y >= VIEWPORT_MARGIN &&
    point.x + size.width <= viewport.width - VIEWPORT_MARGIN &&
    point.y + size.height <= viewport.height - VIEWPORT_MARGIN
  );
}

/**
 * Places a tooltip next to an anchor. The preferred side is used when the tooltip fits there;
 * otherwise the opposite side is tried, and the result is always clamped into the viewport.
 */
export function placeFloating(
  anchor: Box,
  size: Size,
  viewport: Size,
  preferred: Placement = 'bottom',
  gap = 6,
): FloatingPlacement {
  let placement = preferred;
  let point = candidate(anchor, size, placement, gap);
  if (!fits(point, size, viewport)) {
    const flipped = OPPOSITE[preferred];
    const alt = candidate(anchor, size, flipped, gap);
    if (fits(alt, size, viewport)) {
      placement = flipped;
      point = alt;
    }
  }
  return { ...placeAtPoint(point, size, viewport), placement };
}
