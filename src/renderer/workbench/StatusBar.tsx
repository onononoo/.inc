import { useMemo, type ReactNode } from 'react';
import type { StatusBarItem } from '../contracts/layout';
import { service } from '../services/registry';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';
import { cx } from '../ui/cx';
import { useStatusBarStore } from './services';

function Content({ item }: { item: StatusBarItem }): ReactNode {
  return (
    <>
      {item.icon && <Icon name={item.icon} size={14} />}
      {item.text !== undefined && item.text !== null && item.text !== '' && (
        <span className="wb-status-text">{item.text}</span>
      )}
    </>
  );
}

function Item({ item }: { item: StatusBarItem }) {
  const className = cx(
    'wb-status-item',
    item.tone && item.tone !== 'default' && `is-${item.tone}`,
    item.id === 'restricted' && 'is-restricted',
    item.id === 'managed' && 'is-managed',
  );
  const body = item.command ? (
    <button
      type="button"
      className={className}
      data-testid={`status-${item.id}`}
      onClick={() => void service('commands').execute(item.command as string)}
    >
      <Content item={item} />
    </button>
  ) : (
    <span className={className} data-testid={`status-${item.id}`}>
      <Content item={item} />
    </span>
  );
  return item.tooltip ? (
    <Tooltip content={item.tooltip} placement="top">
      {body}
    </Tooltip>
  ) : (
    body
  );
}

/**
 * 24px status bar fed by the StatusBarService. On the left a higher priority sits nearer the
 * window edge, on the right it sits nearer the right edge. The bar never changes colour for state.
 */
export function StatusBar() {
  const items = useStatusBarStore((s) => s.items);
  const { left, right } = useMemo(() => {
    const visible = Object.values(items).filter((i) => i.visible !== false);
    return {
      left: visible.filter((i) => i.side === 'left').sort((a, b) => b.priority - a.priority),
      right: visible.filter((i) => i.side === 'right').sort((a, b) => a.priority - b.priority),
    };
  }, [items]);

  return (
    <footer className="wb-statusbar" aria-label="Status bar">
      <div className="wb-status-side">
        {left.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </div>
      <div className="wb-status-side wb-status-right">
        {right.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </div>
    </footer>
  );
}
