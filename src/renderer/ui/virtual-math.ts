/** Pure windowing arithmetic for VirtualList. */

export interface VisibleRange {
  /** First rendered row (inclusive). */
  start: number;
  /** One past the last rendered row. */
  end: number;
}

/** Rows to render for the current scroll position, including `overscan` rows on each side. */
export function visibleRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  count: number,
  overscan: number,
): VisibleRange {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight);
  return {
    start: Math.max(0, first - overscan),
    end: Math.min(count, last + overscan),
  };
}

export type ScrollAlign = 'nearest' | 'start' | 'center' | 'end';

/** The scrollTop that brings `index` into view, or the current value when it is already visible. */
export function scrollTopFor(
  index: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  align: ScrollAlign = 'nearest',
): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  switch (align) {
    case 'start':
      return top;
    case 'end':
      return bottom - viewportHeight;
    case 'center':
      return top - (viewportHeight - rowHeight) / 2;
    case 'nearest':
      if (top < scrollTop) return top;
      if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
      return scrollTop;
  }
}

/** The active row after a navigation key, or null when the key is not a navigation key. */
export function navigateIndex(
  key: string,
  current: number,
  count: number,
  pageSize: number,
): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const from = current < 0 ? -1 : current;
  switch (key) {
    case 'ArrowDown':
      return Math.min(last, from + 1);
    case 'ArrowUp':
      return from <= 0 ? 0 : from - 1;
    case 'PageDown':
      return Math.min(last, Math.max(0, from) + Math.max(1, pageSize));
    case 'PageUp':
      return Math.max(0, Math.max(0, from) - Math.max(1, pageSize));
    case 'Home':
      return 0;
    case 'End':
      return last;
    default:
      return null;
  }
}
