import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { dragSize, keySize, type SplitterOrientation } from './splitter-math';
import { cx } from './cx';

export interface SplitterProps {
  /**
   * vertical: a vertical bar between left and right panes (resizes a width).
   * horizontal: a horizontal bar between top and bottom panes (resizes a height).
   */
  orientation: SplitterOrientation;
  /** Current size in CSS pixels of the pane this bar resizes. */
  size: number;
  min: number;
  max: number;
  /** Size restored by double-click and Enter. */
  defaultSize: number;
  /** True when the resized pane sits after the bar (a bottom panel: dragging up grows it). */
  invert?: boolean;
  /** Accessible name, e.g. "Resize sidebar". */
  label: string;
  /** Called continuously while dragging and on every key step. */
  onChange: (size: number) => void;
  /** Called once when a gesture ends (release, key press, double-click): persist the value here. */
  onCommit?: (size: number) => void;
  /** Id of the pane being resized (aria-controls). */
  controls?: string;
  className?: string;
}

interface DragState {
  startPointer: number;
  startSize: number;
  latest: number;
}

/**
 * Resize handle: a 1px hairline with a wider hit area. Works with the pointer (drag, double-click
 * to reset) and the keyboard (arrow keys, Shift for large steps, Home, End, Enter to reset).
 */
export function Splitter({
  orientation,
  size,
  min,
  max,
  defaultSize,
  invert = false,
  label,
  onChange,
  onCommit,
  controls,
  className,
}: SplitterProps) {
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);
  const vertical = orientation === 'vertical';

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startPointer: vertical ? e.clientX : e.clientY, startSize: size, latest: size };
    setDragging(true);
    document.body.classList.add(vertical ? 'ui-resizing-col' : 'ui-resizing-row');
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const delta = (vertical ? e.clientX : e.clientY) - state.startPointer;
    const next = dragSize(state.startSize, delta, min, max, invert);
    if (next === state.latest) return;
    state.latest = next;
    onChange(next);
  };

  const finish = (e: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    setDragging(false);
    document.body.classList.remove('ui-resizing-col', 'ui-resizing-row');
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onCommit?.(state.latest);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = keySize(e.key, e.shiftKey, size, min, max, orientation, invert, defaultSize);
    if (next === null) return;
    e.preventDefault();
    if (next !== size) onChange(next);
    onCommit?.(next);
  };

  const onDoubleClick = () => {
    onChange(defaultSize);
    onCommit?.(defaultSize);
  };

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-controls={controls}
      aria-valuenow={size}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={cx(
        'ui-splitter',
        vertical ? 'ui-splitter-vertical' : 'ui-splitter-horizontal',
        dragging && 'is-dragging',
        className,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={() => {
        if (drag.current) {
          drag.current = null;
          setDragging(false);
          document.body.classList.remove('ui-resizing-col', 'ui-resizing-row');
        }
      }}
      onKeyDown={onKeyDown}
      onDoubleClick={onDoubleClick}
    />
  );
}
