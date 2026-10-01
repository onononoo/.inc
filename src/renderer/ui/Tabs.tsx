import type { KeyboardEvent, ReactNode } from 'react';
import { Icon, type IconProps } from './Icon';
import { cx } from './cx';
import { nextRovingIndex } from './roving';

export interface TabItem {
  id: string;
  label: string;
  icon?: IconProps['name'];
  /** Trailing content such as a count chip. */
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: readonly TabItem[];
  /** Id of the selected tab. */
  value: string;
  onChange: (id: string) => void;
  /** Accessible name of the tab list. */
  label: string;
  /** Shared prefix so tabs and panels can reference each other (see tabId / tabPanelId). */
  idPrefix: string;
  className?: string;
}

export const tabId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
export const tabPanelId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

/**
 * Horizontal tab list (panel header style: 12px medium, 2px accent underline on the selected tab).
 * Roving tabindex: one tab stop; arrows, Home and End move and select. Pair each tab with an
 * element that has role="tabpanel", id={tabPanelId(prefix, id)} and aria-labelledby={tabId(...)}.
 */
export function Tabs({ items, value, onChange, label, idPrefix, className }: TabsProps) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const enabled = items.filter((item) => !item.disabled);
    const current = enabled.findIndex((item) => item.id === value);
    const next = nextRovingIndex(current, enabled.length, event.key, 'horizontal');
    if (next === null) return;
    event.preventDefault();
    const target = enabled[next];
    if (!target) return;
    onChange(target.id);
    const el = event.currentTarget.querySelector<HTMLElement>(
      `#${CSS.escape(tabId(idPrefix, target.id))}`,
    );
    el?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      className={cx('ui-tabs', className)}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabId(idPrefix, item.id)}
            aria-selected={selected}
            aria-controls={tabPanelId(idPrefix, item.id)}
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className={cx('ui-tab', selected && 'is-selected')}
            onClick={() => onChange(item.id)}
          >
            {item.icon && <Icon name={item.icon} />}
            <span className="ui-tab-label">{item.label}</span>
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}
