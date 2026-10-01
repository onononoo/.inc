import type { ReactNode } from 'react';
import { cx } from './cx';

export interface EmptyStateProps {
  /** One bold line stating the situation. */
  title: string;
  /** One short sentence saying what to do. */
  description?: ReactNode;
  /** The single primary action. */
  action?: ReactNode;
  /** Shortcut hint shown under the action, e.g. a Kbd. */
  hint?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, hint, className }: EmptyStateProps) {
  return (
    <div className={cx('ui-empty', className)}>
      <p className="ui-empty-title">{title}</p>
      {description && <p className="ui-empty-description">{description}</p>}
      {action && <div className="ui-empty-action">{action}</div>}
      {hint && <p className="ui-empty-hint">{hint}</p>}
    </div>
  );
}
