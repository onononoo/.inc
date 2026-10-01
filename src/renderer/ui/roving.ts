import { useCallback, useLayoutEffect, useRef, type KeyboardEvent } from 'react';

export type RovingOrientation = 'horizontal' | 'vertical';

/**
 * Index to focus after `key`, or null when the key is not a navigation key for this orientation.
 * Home and End always work; arrows depend on the orientation. With `loop` the ends wrap around.
 */
export function nextRovingIndex(
  current: number,
  count: number,
  key: string,
  orientation: RovingOrientation,
  loop = true,
): number | null {
  if (count <= 0) return null;
  const forward = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const backward = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key !== forward && key !== backward) return null;
  const delta = key === forward ? 1 : -1;
  const base = current < 0 ? (delta > 0 ? -1 : count) : current;
  const next = base + delta;
  if (next < 0) return loop ? count - 1 : 0;
  if (next >= count) return loop ? 0 : count - 1;
  return next;
}

export interface RovingOptions {
  orientation: RovingOrientation;
  /** CSS selector for the focusable items. Disabled items are skipped. */
  selector?: string;
  loop?: boolean;
}

const DEFAULT_SELECTOR = '[data-roving]';

function itemsOf(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
  );
}

/**
 * Roving tabindex for a group of controls (toolbar, tab list, activity bar).
 *
 * Exactly one item is in the tab order; arrow keys, Home and End move focus between items.
 * Items only need the `data-roving` attribute (or match `selector`); the hook owns their
 * `tabindex`, so do not set it in JSX. Attach `ref` and `onKeyDown`/`onFocus` to the container.
 */
export function useRovingTabindex<T extends HTMLElement = HTMLElement>(options: RovingOptions) {
  const { orientation, loop = true } = options;
  const selector = options.selector ?? DEFAULT_SELECTOR;
  const containerRef = useRef<T | null>(null);
  const activeRef = useRef<HTMLElement | null>(null);

  const sync = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const items = itemsOf(container, selector);
    if (items.length === 0) return;
    let active = activeRef.current;
    if (!active || !items.includes(active)) {
      active = items.find((el) => el.getAttribute('aria-pressed') === 'true') ?? items[0] ?? null;
      activeRef.current = active;
    }
    for (const el of items) el.tabIndex = el === active ? 0 : -1;
  }, [selector]);

  // Runs after every render: items may have been added, removed or re-enabled.
  useLayoutEffect(sync);

  const setRef = useCallback(
    (node: T | null) => {
      containerRef.current = node;
      if (node) sync();
    },
    [sync],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const container = containerRef.current;
      if (!container) return;
      const items = itemsOf(container, selector);
      const current = items.findIndex((el) => el === event.target || el.contains(event.target as Node));
      if (current < 0) return;
      const next = nextRovingIndex(current, items.length, event.key, orientation, loop);
      if (next === null) return;
      event.preventDefault();
      const target = items[next];
      if (!target) return;
      activeRef.current = target;
      for (const el of items) el.tabIndex = el === target ? 0 : -1;
      target.focus();
    },
    [selector, orientation, loop],
  );

  const onFocus = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const items = itemsOf(container, selector);
      const hit = items.find((el) => el === event.target || el.contains(event.target as Node));
      if (!hit || hit === activeRef.current) return;
      activeRef.current = hit;
      for (const el of items) el.tabIndex = el === hit ? 0 : -1;
    },
    [selector],
  );

  return { ref: setRef, onKeyDown, onFocus };
}
