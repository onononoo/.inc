import { ICONS, resolveIconName, type IconName } from './icons';
import { cx } from './cx';

export interface IconProps {
  /** A name from the shared icon set (see icons.ts). Unknown names render an empty box of the same size. */
  name: IconName | (string & {});
  size?: number;
  /** Accessible name. Omit for decorative icons next to a text label. */
  label?: string;
  className?: string;
}

/** The one icon component: lucide glyphs at 16px with a 1.5px stroke, in the current text colour. */
export function Icon({ name, size = 16, label, className }: IconProps) {
  const resolved = resolveIconName(name);
  if (!resolved) {
    return (
      <span
        className={cx('ui-icon', 'ui-icon-empty', className)}
        style={{ width: size, height: size }}
        aria-hidden="true"
      />
    );
  }
  const Glyph = ICONS[resolved];
  return (
    <Glyph
      className={cx('ui-icon', className)}
      size={size}
      strokeWidth={1.5}
      absoluteStrokeWidth
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
    />
  );
}
