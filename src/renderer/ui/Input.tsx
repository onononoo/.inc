import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import { Icon } from './Icon';
import { cx } from './cx';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Marks the field invalid (error border). Pair with a message through Field. */
  invalid?: boolean;
  /** Numeric inputs are narrow, right-aligned and use tabular figures. */
  numeric?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/** 28px text input. Always give it a visible label (Field) or an aria-label. */
export function Input({ invalid, numeric, className, type = 'text', ref, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      ref={ref}
      type={numeric ? 'number' : type}
      className={cx('ui-input', numeric && 'ui-input-numeric', className)}
      aria-invalid={invalid || undefined}
      spellCheck={rest.spellCheck ?? false}
    />
  );
}

export interface FieldProps {
  label: string;
  /** Hint under the control. */
  description?: ReactNode;
  /** Error message; shown in the error colour with an icon and wired to the control. */
  error?: string;
  /** Render the control; receives the ids to attach. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
  className?: string;
}

/** Label, control, hint and error message wired together with the right ARIA attributes. */
export function Field({ label, description, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [description ? hintId : '', error ? errorId : ''].filter(Boolean).join(' ');
  return (
    <div className={cx('ui-field', className)}>
      <label className="ui-field-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, describedBy: describedBy || undefined, invalid: Boolean(error) })}
      {description && (
        <p className="ui-field-hint" id={hintId}>
          {description}
        </p>
      )}
      {error && (
        <p className="ui-field-error" id={errorId} role="alert">
          <Icon name="alert-circle" size={14} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
