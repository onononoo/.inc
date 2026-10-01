import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { MenuItem } from '../contracts/layout';
import { Icon } from './Icon';
import { cx } from './cx';
import { placeAtPoint, placeSubmenu, type Box, type Point } from './geometry';
import {
  firstEnabledIndex,
  lastEnabledIndex,
  nextEnabledIndex,
  typeaheadIndex,
} from './menu-nav';

const TYPEAHEAD_RESET_MS = 700;
const SUBMENU_OPEN_DELAY_MS = 140;

type Origin = { kind: 'point'; point: Point } | { kind: 'item'; anchor: Box };

interface PanelProps {
  items: readonly MenuItem[];
  origin: Origin;
  depth: number;
  label: string;
  /** Focus the first enabled item as soon as the panel opens. */
  focusFirst: boolean;
  onActivate: (item: MenuItem) => void;
  /** Close the whole menu. `restore` returns focus to where it was before the menu opened. */
  onCloseAll: (restore: boolean) => void;
  /** Close only this submenu and return to its parent item. */
  onCloseSelf?: () => void;
}

function MenuPanel({
  items,
  origin,
  depth,
  label,
  focusFirst,
  onActivate,
  onCloseAll,
  onCloseSelf,
}: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [position, setPosition] = useState<Point | null>(null);
  const [active, setActive] = useState(-1);
  const [openSub, setOpenSub] = useState<{ index: number; anchor: Box; focusFirst: boolean } | null>(
    null,
  );
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typed = useRef({ buffer: '', timer: undefined as ReturnType<typeof setTimeout> | undefined });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const size = { width: rect.width, height: rect.height };
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    setPosition(
      origin.kind === 'point'
        ? placeAtPoint(origin.point, size, viewport)
        : placeSubmenu(origin.anchor, size, viewport),
    );
  }, [origin]);

  const initial = useRef({ focusFirst, items });
  useEffect(() => {
    // Only on mount: later changes come from the person using the menu.
    if (initial.current.focusFirst) setActive(firstEnabledIndex(initial.current.items));
    else ref.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (active >= 0) itemRefs.current[active]?.focus({ preventScroll: true });
  }, [active]);

  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      if (typed.current.timer) clearTimeout(typed.current.timer);
    },
    [],
  );

  const openSubmenu = useCallback(
    (index: number, withKeyboard: boolean) => {
      const item = items[index];
      const el = itemRefs.current[index];
      if (!item?.submenu || item.disabled || !el) return;
      const rect = el.getBoundingClientRect();
      setOpenSub({
        index,
        anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        focusFirst: withKeyboard,
      });
    },
    [items],
  );

  const activate = (index: number) => {
    const item = items[index];
    if (!item || item.disabled) return;
    if (item.submenu) openSubmenu(index, true);
    else onActivate(item);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case 'ArrowDown':
        handled();
        setActive(nextEnabledIndex(items, active, 1));
        return;
      case 'ArrowUp':
        handled();
        setActive(nextEnabledIndex(items, active, -1));
        return;
      case 'Home':
        handled();
        setActive(firstEnabledIndex(items));
        return;
      case 'End':
        handled();
        setActive(lastEnabledIndex(items));
        return;
      case 'ArrowRight':
        if (active >= 0 && items[active]?.submenu) {
          handled();
          openSubmenu(active, true);
        }
        return;
      case 'ArrowLeft':
        if (onCloseSelf) {
          handled();
          onCloseSelf();
        }
        return;
      case 'Enter':
      case ' ':
        handled();
        if (active >= 0) activate(active);
        return;
      case 'Escape':
        handled();
        if (onCloseSelf) onCloseSelf();
        else onCloseAll(true);
        return;
      case 'Tab':
        handled();
        onCloseAll(true);
        return;
      default:
        if (event.key.length === 1 && event.key !== ' ') {
          handled();
          const state = typed.current;
          if (state.timer) clearTimeout(state.timer);
          state.buffer += event.key;
          state.timer = setTimeout(() => (state.buffer = ''), TYPEAHEAD_RESET_MS);
          const index = typeaheadIndex(items, state.buffer, active);
          if (index >= 0) setActive(index);
        }
    }
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Element | null;
    if (!next || !next.closest?.('[data-ui-menu]')) onCloseAll(false);
  };

  const hover = (index: number) => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    const item = items[index];
    if (!item) return;
    if (!item.disabled) setActive(index);
    if (openSub && openSub.index !== index) setOpenSub(null);
    if (item.submenu && !item.disabled && openSub?.index !== index) {
      hoverTimer.current = setTimeout(() => openSubmenu(index, false), SUBMENU_OPEN_DELAY_MS);
    }
  };

  return (
    <>
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        aria-orientation="vertical"
        tabIndex={-1}
        data-ui-menu=""
        data-depth={depth}
        className="ui-menu"
        style={{
          left: position?.x ?? 0,
          top: position?.y ?? 0,
          visibility: position ? 'visible' : 'hidden',
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, index) => {
          const checkable = item.checked !== undefined;
          return (
            <Fragment key={item.id}>
              {item.separatorBefore && index > 0 && (
                <div role="separator" className="ui-menu-separator" />
              )}
              <div
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                role={checkable ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={checkable ? item.checked : undefined}
                aria-disabled={item.disabled || undefined}
                aria-haspopup={item.submenu ? 'menu' : undefined}
                aria-expanded={item.submenu ? openSub?.index === index : undefined}
                tabIndex={-1}
                data-active={active === index ? '' : undefined}
                className={cx('ui-menu-item', item.disabled && 'is-disabled', item.danger && 'is-danger')}
                onPointerMove={() => hover(index)}
                onClick={() => activate(index)}
              >
                <span className="ui-menu-check" aria-hidden="true">
                  {item.checked && <Icon name="check" />}
                </span>
                <span className="ui-menu-label">{item.label}</span>
                {item.keybinding && <span className="ui-menu-keys">{item.keybinding}</span>}
                {item.submenu && <Icon name="chevron-right" className="ui-menu-arrow" />}
              </div>
            </Fragment>
          );
        })}
      </div>
      {openSub && items[openSub.index]?.submenu && (
        <MenuPanel
          key={openSub.index}
          items={items[openSub.index]?.submenu ?? []}
          origin={{ kind: 'item', anchor: openSub.anchor }}
          depth={depth + 1}
          label={items[openSub.index]?.label ?? label}
          focusFirst={openSub.focusFirst}
          onActivate={onActivate}
          onCloseAll={onCloseAll}
          onCloseSelf={() => {
            const index = openSub.index;
            setOpenSub(null);
            setActive(index);
            itemRefs.current[index]?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

export interface ContextMenuProps {
  items: readonly MenuItem[];
  /** Viewport coordinates of the pointer (or the trigger) that opened the menu. */
  position: Point;
  /** Called once when the menu has closed for any reason. */
  onClose: () => void;
  /** Move focus to the first item immediately (use when the menu was opened with the keyboard). */
  focusFirst?: boolean;
  /** Accessible name; defaults to "Context menu". */
  label?: string;
}

/**
 * Context menu rendered in a portal with design tokens (the native menus are separate). Keyboard:
 * arrows, Home, End, type-ahead, Right and Left for submenus, Enter and Space to run, Escape to
 * close. It closes when focus leaves it, on an outside press, on resize and on window blur, and
 * puts focus back where it was. It is clamped inside the viewport.
 */
export function ContextMenu({ items, position, onClose, focusFirst = false, label = 'Context menu' }: ContextMenuProps) {
  const previousFocus = useRef<Element | null>(document.activeElement);
  const closed = useRef(false);

  const closeAll = useCallback(
    (restore: boolean) => {
      if (closed.current) return;
      closed.current = true;
      onClose();
      if (restore) {
        const target = previousFocus.current;
        if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
      }
    },
    [onClose],
  );

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.('[data-ui-menu]')) closeAll(false);
    };
    const dismiss = () => closeAll(false);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [closeAll]);

  const onActivate = useCallback(
    (item: MenuItem) => {
      closeAll(true);
      // Run after focus is back, so an action that moves focus (a dialog, an editor) wins.
      setTimeout(() => item.run?.(), 0);
    },
    [closeAll],
  );

  return createPortal(
    <MenuPanel
      items={items}
      origin={{ kind: 'point', point: position }}
      depth={0}
      label={label}
      focusFirst={focusFirst}
      onActivate={onActivate}
      onCloseAll={closeAll}
    />,
    document.body,
  );
}
