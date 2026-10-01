import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { placeFloating, type Box, type Placement, type Point } from './geometry';

/** Delay before a tooltip appears; after one closed recently the next opens at once. */
export const TOOLTIP_DELAY_MS = 500;
const WARM_WINDOW_MS = 300;

let lastClosedAt = 0;

interface TriggerProps {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
  'aria-describedby'?: string;
}

export interface TooltipProps {
  content: ReactNode;
  /** Keybinding label appended after the text, e.g. "Ctrl+B". */
  shortcut?: string;
  placement?: Placement;
  delay?: number;
  /**
   * Set when the trigger already carries the same text as its accessible name (icon buttons), so
   * the tooltip is not announced a second time.
   */
  labelled?: boolean;
  /** A single element that receives the pointer and focus handlers. */
  children: ReactElement<TriggerProps>;
}

interface BubbleProps {
  anchor: Box;
  placement: Placement;
  id: string;
  children: ReactNode;
}

function Bubble({ anchor, placement, id, children }: BubbleProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<(Point & { placement: Placement }) | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(
      placeFloating(
        anchor,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
        placement,
      ),
    );
  }, [anchor, placement]);

  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="ui-tooltip"
      style={{
        left: position?.x ?? 0,
        top: position?.y ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Delayed, accessible tooltip. Shows after a short hover or on keyboard focus, hides on leave,
 * blur, press, scroll and Escape. The trigger is described by it unless `labelled` is set.
 */
export function Tooltip({
  content,
  shortcut,
  placement = 'bottom',
  delay = TOOLTIP_DELAY_MS,
  labelled = false,
  children,
}: TooltipProps) {
  const id = useId();
  const [anchor, setAnchor] = useState<Box | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    setAnchor((current) => {
      if (current) lastClosedAt = Date.now();
      return null;
    });
  }, []);

  const schedule = useCallback(
    (element: HTMLElement, immediate: boolean) => {
      if (timer.current) clearTimeout(timer.current);
      const wait = immediate || Date.now() - lastClosedAt < WARM_WINDOW_MS ? 0 : delay;
      const open = () => {
        const rect = element.getBoundingClientRect();
        setAnchor({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      };
      if (wait === 0) open();
      else timer.current = setTimeout(open, wait);
    },
    [delay],
  );

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const isOpen = anchor !== null;
  useEffect(() => {
    if (!isOpen) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('blur', hide);
    };
  }, [isOpen, hide]);

  const hasContent =
    content !== undefined && content !== null && content !== false && content !== '';
  const child = Children.only(children);
  if (!hasContent || !isValidElement<TriggerProps>(child)) return child;
  const original = child.props;

  const trigger = cloneElement(child, {
    onPointerEnter: (e) => {
      original.onPointerEnter?.(e);
      if (e.pointerType === 'touch') return;
      schedule(e.currentTarget, false);
    },
    onPointerLeave: (e) => {
      original.onPointerLeave?.(e);
      hide();
    },
    onPointerDown: (e) => {
      original.onPointerDown?.(e);
      hide();
    },
    onFocus: (e) => {
      original.onFocus?.(e);
      if (e.currentTarget.matches(':focus-visible')) schedule(e.currentTarget, true);
    },
    onBlur: (e) => {
      original.onBlur?.(e);
      hide();
    },
    onKeyDown: (e) => {
      original.onKeyDown?.(e);
      if (e.key === 'Escape') hide();
    },
    'aria-describedby': isOpen && !labelled ? id : original['aria-describedby'],
  });

  return (
    <>
      {trigger}
      {anchor &&
        createPortal(
          <Bubble anchor={anchor} placement={placement} id={id}>
            <span className="ui-tooltip-text">{content}</span>
            {shortcut && <span className="ui-tooltip-shortcut">{shortcut}</span>}
          </Bubble>,
          document.body,
        )}
    </>
  );
}
