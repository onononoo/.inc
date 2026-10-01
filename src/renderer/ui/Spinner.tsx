import { cx } from './cx';

export interface SpinnerProps {
  size?: number;
  /** Accessible name; defaults to "Loading". Pass an empty string when the surrounding text already says it. */
  label?: string;
  className?: string;
}

/** Indeterminate progress. Becomes a static ring under prefers-reduced-motion. */
export function Spinner({ size = 16, label = 'Loading', className }: SpinnerProps) {
  return (
    <span
      className={cx('ui-spinner', className)}
      style={{ width: size, height: size }}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    />
  );
}
