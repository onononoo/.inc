import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type AriaRole,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { cx } from './cx';
import {
  navigateIndex,
  scrollTopFor,
  visibleRange,
  type ScrollAlign,
  type VisibleRange,
} from './virtual-math';

export interface VirtualRowState {
  /** True for the row that holds the list's active (keyboard) position. */
  active: boolean;
  /** DOM id to put on the row element; the list points aria-activedescendant at it. */
  id: string;
}

export interface VirtualListHandle {
  scrollToIndex(index: number, align?: ScrollAlign): void;
  focus(): void;
  /** The scrolling element, for consumers that need to measure or restore scroll. */
  element(): HTMLDivElement | null;
}

export interface VirtualListProps {
  count: number;
  /** Fixed row height in CSS pixels. The design row height is 24. */
  rowHeight: number;
  /** Returns the row element. Put `state.id` on it and style `state.active`. */
  renderRow: (index: number, state: VirtualRowState) => ReactNode;
  /** Extra rows rendered above and below the viewport. */
  overscan?: number;
  /** listbox (default), tree, list or grid; rows must carry the matching child role. */
  role?: AriaRole;
  /** Accessible name of the list. */
  label: string;
  /** Controlled active row (keyboard position). Omit to let the list keep it. */
  activeIndex?: number;
  onActiveIndexChange?: (index: number) => void;
  /** Enter on the active row. */
  onActivate?: (index: number, event: KeyboardEvent<HTMLDivElement>) => void;
  /** Arrow, Page, Home and End navigation. Default true. */
  keyboard?: boolean;
  /** Called first for key presses on the list; call preventDefault to take over a key. */
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  /** Rendered instead of rows when `count` is 0. */
  empty?: ReactNode;
  multiselectable?: boolean;
  className?: string;
  ref?: Ref<VirtualListHandle>;
}

/**
 * Fixed-row-height windowing list. Only the rows in (and just around) the viewport exist in the
 * DOM, so a list of a million rows costs the same as one of fifty. The scroller is the focus
 * target and exposes the active row through aria-activedescendant, so rows themselves stay out of
 * the tab order. Fixed height keeps the maths exact: the supported range is about 1.2 million rows
 * at 24px (the browser's maximum element height).
 */
export function VirtualList({
  count,
  rowHeight,
  renderRow,
  overscan = 8,
  role = 'listbox',
  label,
  activeIndex,
  onActiveIndexChange,
  onActivate,
  keyboard = true,
  onKeyDown,
  empty,
  multiselectable,
  className,
  ref,
}: VirtualListProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  const prefix = useId();
  const [range, setRange] = useState<VisibleRange>({ start: 0, end: 0 });
  const [innerActive, setInnerActive] = useState(-1);
  const viewport = useRef(0);
  const controlled = activeIndex !== undefined;
  const active = Math.min(controlled ? activeIndex : innerActive, count - 1);

  const recompute = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    viewport.current = el.clientHeight;
    const next = visibleRange(el.scrollTop, el.clientHeight, rowHeight, count, overscan);
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [rowHeight, count, overscan]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(recompute);
    observer.observe(el);
    return () => observer.disconnect();
  }, [recompute]);

  const scrollToIndex = useCallback(
    (index: number, align: ScrollAlign = 'nearest') => {
      const el = scroller.current;
      if (!el || index < 0 || index >= count) return;
      const top = scrollTopFor(index, el.scrollTop, el.clientHeight, rowHeight, align);
      if (top !== el.scrollTop) el.scrollTop = Math.max(0, top);
    },
    [count, rowHeight],
  );

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex,
      focus: () => scroller.current?.focus(),
      element: () => scroller.current,
    }),
    [scrollToIndex],
  );

  const setActive = useCallback(
    (index: number) => {
      if (!controlled) setInnerActive(index);
      onActiveIndexChange?.(index);
      scrollToIndex(index);
    },
    [controlled, onActiveIndexChange, scrollToIndex],
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || !keyboard || event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Enter') {
      if (active >= 0 && onActivate) {
        event.preventDefault();
        onActivate(active, event);
      }
      return;
    }
    const page = Math.max(1, Math.floor(viewport.current / rowHeight) - 1);
    const next = navigateIndex(event.key, active, count, page);
    if (next === null) return;
    event.preventDefault();
    if (next !== active) setActive(next);
  };

  const rows: ReactNode[] = [];
  for (let i = range.start; i < Math.min(range.end, count); i++) {
    const id = `${prefix}-row-${i}`;
    rows.push(
      <div
        key={i}
        role="none"
        className="ui-vlist-row"
        style={{ top: i * rowHeight, height: rowHeight }}
      >
        {renderRow(i, { active: i === active, id })}
      </div>,
    );
  }

  const activeVisible = active >= range.start && active < range.end;

  return (
    <div
      ref={scroller}
      role={role}
      aria-label={label}
      aria-multiselectable={multiselectable || undefined}
      aria-rowcount={role === 'grid' || role === 'treegrid' ? count : undefined}
      aria-activedescendant={activeVisible ? `${prefix}-row-${active}` : undefined}
      tabIndex={0}
      className={cx('ui-vlist', className)}
      onScroll={recompute}
      onKeyDown={handleKeyDown}
    >
      {count === 0 ? (
        empty
      ) : (
        <div className="ui-vlist-spacer" role="none" style={{ height: count * rowHeight }}>
          {rows}
        </div>
      )}
    </div>
  );
}
