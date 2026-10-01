import { useEffect, useRef, useState } from 'react';
import type { NotificationAction, NotificationLevel } from '../contracts/layout';
import { Button } from './Button';
import { Icon, type IconProps } from './Icon';
import { IconButton } from './IconButton';
import { cx } from './cx';

const LEVEL_ICON: Record<NotificationLevel, IconProps['name']> = {
  info: 'info',
  warning: 'alert-triangle',
  error: 'x-circle',
};

export interface ToastProps {
  level: NotificationLevel;
  /** Title line. */
  message: string;
  /** One supporting line (up to a few wrapped lines for long errors). */
  detail?: string;
  /** At most two actions are shown. */
  actions?: readonly NotificationAction[];
  /** Milliseconds before it dismisses itself; 0 keeps it until dismissed. */
  timeout: number;
  onDismiss: () => void;
}

/**
 * One notification. Errors use role=alert, the rest role=status. The auto-dismiss timer pauses
 * while the pointer is over the toast or focus is inside it, and resumes with the time left.
 */
export function Toast({ level, message, detail, actions = [], timeout, onDismiss }: ToastProps) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(timeout);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (timeout <= 0 || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismiss.current(), Math.max(0, remaining.current));
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, timeout]);

  return (
    <div
      className={cx('ui-toast', `ui-toast-${level}`)}
      role={level === 'error' ? 'alert' : 'status'}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          dismiss.current();
        }
      }}
    >
      <Icon name={LEVEL_ICON[level]} className="ui-toast-icon" />
      <div className="ui-toast-content">
        <p className="ui-toast-title">{message}</p>
        {detail && <p className="ui-toast-detail">{detail}</p>}
        {actions.length > 0 && (
          <div className="ui-toast-actions">
            {actions.slice(0, 2).map((action, index) => (
              <Button
                key={action.label}
                size="sm"
                variant={index === 0 ? 'secondary' : 'ghost'}
                onClick={() => {
                  action.run();
                  dismiss.current();
                }}
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      <IconButton icon="close" label="Dismiss notification" onClick={onDismiss} />
    </div>
  );
}
