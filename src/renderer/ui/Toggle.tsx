import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from './cx';

export interface ToggleProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'role' | 'children'
> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Adjacent label text; it names the switch. Without it pass aria-label. */
  label?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Switch: 28 x 16 track, 10 x 10 knob that moves 12px. State is shown by the knob position as
 * well as the colour, and always paired with a text label.
 */
export function Toggle({
  checked,
  onChange,
  label,
  className,
  disabled,
  ref,
  ...rest
}: ToggleProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cx('ui-toggle', checked && 'is-on', className)}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle-track" aria-hidden="true">
        <span className="ui-toggle-knob" />
      </span>
      {label !== undefined && label !== null && <span className="ui-toggle-label">{label}</span>}
    </button>
  );
}
