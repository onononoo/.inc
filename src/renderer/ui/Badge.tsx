import type { ReactNode } from 'react';
import { Icon, type IconProps } from './Icon';
import { cx } from './cx';

export type BadgeTone = 'neutral' | 'accent' | 'info' | 'success' | 'warning' | 'error';

export interface BadgeProps {
  /**
   * count: small numeric chip (panel tabs, 16px). status: pill with icon and tinted fill (rare).
   * Default is count.
   */
  variant?: 'count' | 'status';
  tone?: BadgeTone;
  icon?: IconProps['name'];
  children: ReactNode;
  className?: string;
  /** Accessible text when the visible content is only a number. */
  label?: string;
}

const STATUS_ICON: Partial<Record<BadgeTone, IconProps['name']>> = {
  info: 'info',
  success: 'check-circle',
  warning: 'alert-triangle',
  error: 'x-circle',
};

/** Compact label. Status pills always carry an icon, so colour is never the only signal. */
export function Badge({
  variant = 'count',
  tone = 'neutral',
  icon,
  children,
  className,
  label,
}: BadgeProps) {
  const glyph = icon ?? (variant === 'status' ? STATUS_ICON[tone] : undefined);
  return (
    <span
      className={cx('ui-badge', `ui-badge-${variant}`, `ui-badge-${tone}`, className)}
      aria-label={label}
    >
      {glyph && <Icon name={glyph} size={12} />}
      {children}
    </span>
  );
}
