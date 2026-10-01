import type { ButtonHTMLAttributes, Ref } from 'react';
import { Icon, type IconProps } from './Icon';
import { Tooltip } from './Tooltip';
import type { Placement } from './geometry';
import { cx } from './cx';

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  icon: IconProps['name'];
  /** Required: the accessible name and the tooltip text. Sentence case, e.g. "Close panel". */
  label: string;
  /** Keybinding label shown in the tooltip, e.g. "Ctrl+J". */
  shortcut?: string;
  /** Toggle state for buttons that stay pressed (aria-pressed). */
  pressed?: boolean;
  /** md is the 24px toolbar target, lg the 48 x 44 activity bar target. */
  size?: 'md' | 'lg';
  tooltipPlacement?: Placement;
  ref?: Ref<HTMLButtonElement>;
}

/** Icon-only button. The label is mandatory, so every icon button has a name and a tooltip. */
export function IconButton({
  icon,
  label,
  shortcut,
  pressed,
  size = 'md',
  tooltipPlacement = 'bottom',
  className,
  type = 'button',
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip content={label} shortcut={shortcut} placement={tooltipPlacement} labelled>
      <button
        {...rest}
        ref={ref}
        type={type}
        className={cx('ui-icon-btn', size === 'lg' && 'ui-icon-btn-lg', className)}
        aria-label={label}
        aria-pressed={pressed}
        aria-keyshortcuts={shortcut}
      >
        <Icon name={icon} />
      </button>
    </Tooltip>
  );
}
