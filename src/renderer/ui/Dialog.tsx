import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';

export interface DialogProps {
  title: string;
  /** Body content. Rendered under the title; wrap prose in <p> for correct spacing. */
  children?: ReactNode;
  /** Right-aligned actions; the primary action goes last. */
  actions?: ReactNode;
  /** Width in CSS pixels: 400 for confirmations up to 560 for forms. */
  width?: number;
  /** Called on Escape. For confirmations this is the cancel path. */
  onClose: () => void;
  /** alertdialog for confirmations that need an answer. */
  role?: 'dialog' | 'alertdialog';
  className?: string;
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let openCount = 0;

function setBackgroundInert(inert: boolean): void {
  const root = document.getElementById('root');
  if (root) root.inert = inert;
}

/**
 * Modal dialog. Focus moves into it (to the element marked data-autofocus, else the first
 * control), Tab stays inside, Escape closes, the app behind it is inert, and focus returns to the
 * previous element when it closes.
 */
export function Dialog({
  title,
  children,
  actions,
  width = 400,
  onClose,
  role = 'dialog',
  className,
}: DialogProps) {
  const titleId = useId();
  const bodyId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    openCount++;
    setBackgroundInert(true);
    const el = panel.current;
    if (el) {
      const target =
        el.querySelector<HTMLElement>('[data-autofocus]') ??
        el.querySelector<HTMLElement>(TABBABLE) ??
        el;
      target.focus({ preventScroll: true });
    }
    return () => {
      openCount--;
      if (openCount === 0) setBackgroundInert(false);
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (event.key !== 'Tab') return;
    const el = panel.current;
    if (!el) return;
    const tabbables = Array.from(el.querySelectorAll<HTMLElement>(TABBABLE)).filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
    if (tabbables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = tabbables[0] as HTMLElement;
    const last = tabbables[tabbables.length - 1] as HTMLElement;
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === el)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="ui-scrim">
      <div
        ref={panel}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? bodyId : undefined}
        tabIndex={-1}
        className={cx('ui-dialog', className)}
        style={{ width }}
        onKeyDown={onKeyDown}
      >
        <h2 className="ui-dialog-title" id={titleId}>
          {title}
        </h2>
        {children && (
          <div className="ui-dialog-body" id={bodyId}>
            {children}
          </div>
        )}
        {actions && <div className="ui-dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}
