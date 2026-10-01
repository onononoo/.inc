import type { ButtonHTMLAttributes, Ref } from 'react';
import { Icon, type IconProps } from './Icon';
import { Spinner } from './Spinner';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** md is 28px high, sm is the 24px compact size. */
  size?: ButtonSize;
  /** Icon name shown before the label. */
  icon?: IconProps['name'];
  /** Shows a spinner and blocks clicks while work is in progress. */
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** Text button. One primary button per view region; danger only inside a confirmation step. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  busy = false,
  className,
  children,
  disabled,
  type = 'button',
  onClick,
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      className={cx('ui-btn', `ui-btn-${variant}`, size === 'sm' && 'ui-btn-sm', className)}
      disabled={disabled}
      aria-busy={busy || undefined}
      onClick={busy ? undefined : onClick}
    >
      {busy ? <Spinner size={14} /> : icon ? <Icon name={icon} /> : null}
      {children !== undefined && children !== null && (
        <span className="ui-btn-label">{children}</span>
      )}
    </button>
  );
}
