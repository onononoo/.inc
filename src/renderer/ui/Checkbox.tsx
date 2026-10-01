import { useEffect, useRef, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { Icon } from './Icon';
import { cx } from './cx';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'onChange' | 'checked'
> {
  checked: boolean;
  /** Shows the mixed state (for example "some changes staged"). */
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label text. */
  children?: ReactNode;
  ref?: Ref<HTMLInputElement>;
}

/** Native checkbox with the product look. The box is drawn, the input stays real for keyboards and readers. */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  children,
  className,
  disabled,
  ref,
  ...rest
}: CheckboxProps) {
  const inner = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <label className={cx('ui-checkbox', disabled && 'is-disabled', className)}>
      <input
        {...rest}
        ref={(node) => {
          inner.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        type="checkbox"
        className="ui-checkbox-input"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        {indeterminate ? (
          <Icon name="minus" size={12} />
        ) : checked ? (
          <Icon name="check" size={12} />
        ) : null}
      </span>
      {children !== undefined && children !== null && (
        <span className="ui-checkbox-label">{children}</span>
      )}
    </label>
  );
}
