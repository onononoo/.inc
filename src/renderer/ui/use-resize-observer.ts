import { useEffect, useRef, type RefObject } from 'react';

/** Run `callback` whenever the element's size changes. The callback may change between renders. */
export function useResizeObserver(ref: RefObject<HTMLElement | null>, callback: () => void): void {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => latest.current());
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
}
