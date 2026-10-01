import type { Ref, SelectHTMLAttributes } from 'react';
import { Icon } from './Icon';
import { cx } from './cx';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string = string> extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'onChange' | 'value'
> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  invalid?: boolean;
  ref?: Ref<HTMLSelectElement>;
}

/** Styled native select: arrow keys, type-ahead and platform pickers keep working. */
export function Select<T extends string = string>({
  value,
  options,
  onChange,
  invalid,
  className,
  ref,
  ...rest
}: SelectProps<T>) {
  return (
    <span className={cx('ui-select', className)}>
      <select
        {...rest}
        ref={ref}
        className="ui-select-control"
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.currentTarget.value as T)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" className="ui-select-chevron" />
    </span>
  );
}
