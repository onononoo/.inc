import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { highlightRuns } from '@shared/fuzzy';
import { Icon } from '../ui/Icon';
import { Kbd } from '../ui/Kbd';
import { Spinner } from '../ui/Spinner';
import { cx } from '../ui/cx';
import { chordHint, quickInput } from './instance';
import { MAX_RESULTS, type QuickItem } from './quick-input-controller';
import './quick-input.css';

function Highlighted({ text, positions }: { text: string; positions?: readonly number[] }) {
  if (!positions || positions.length === 0) return <>{text}</>;
  return (
    <>
      {highlightRuns(text, positions).map((run, i) =>
        run.match ? (
          <mark className="qi-match" key={i}>
            {run.text}
          </mark>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

function Row({
  item,
  index,
  active,
  current,
  listId,
}: {
  item: QuickItem;
  index: number;
  active: boolean;
  current: boolean;
  listId: string;
}) {
  return (
    <div
      id={`${listId}-opt-${index}`}
      role="option"
      aria-selected={active}
      aria-current={current ? 'true' : undefined}
      className={cx('row', 'qi-row', active && 'is-active')}
      data-index={index}
      onPointerDown={(e) => e.preventDefault()}
      onClick={() => quickInput.accept(index)}
    >
      {item.icon && <Icon name={item.icon} className="row-icon" />}
      <span className="row-label">
        <Highlighted text={item.label} positions={item.highlights} />
      </span>
      {item.description && (
        <span className="row-description">
          <Highlighted text={item.description} positions={item.descriptionHighlights} />
        </span>
      )}
      {current && <Icon name="check" className="qi-current" label="Current" />}
      {item.keybinding && (
        <span className="qi-keys">
          <Kbd keys={item.keybinding} />
        </span>
      )}
    </div>
  );
}

/**
 * The single top-centre surface for the command palette, quick open, go to line and every picker.
 * It renders the controller's view; all rules (ranking, validation, focus restore) live there.
 */
export function QuickInputHost() {
  const view = useSyncExternalStore(quickInput.subscribe, quickInput.getView);
  const hint = useSyncExternalStore(chordHint.subscribe, chordHint.get);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const statusId = useId();

  useLayoutEffect(() => {
    if (view.visible) inputRef.current?.focus({ preventScroll: true });
  }, [view.visible, view.sessionId, view.focusNonce]);

  // Keep the active row in view when the arrow keys move it.
  useEffect(() => {
    if (!view.visible || view.activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${view.activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [view.visible, view.activeIndex, view.items]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    const ctrl = e.ctrlKey || e.metaKey;
    switch (e.key) {
      case 'ArrowDown':
        quickInput.move({ by: 1, wrap: true });
        break;
      case 'ArrowUp':
        quickInput.move({ by: -1, wrap: true });
        break;
      case 'PageDown':
        quickInput.move({ by: 8 });
        break;
      case 'PageUp':
        quickInput.move({ by: -8 });
        break;
      case 'Home':
        if (!ctrl && e.currentTarget.value !== '') return;
        quickInput.move({ to: 'first' });
        break;
      case 'End':
        if (!ctrl && e.currentTarget.value !== '') return;
        quickInput.move({ to: 'last' });
        break;
      case 'Enter':
        quickInput.accept();
        break;
      case 'Escape':
        quickInput.cancel();
        break;
      case 'Tab':
        break; // focus stays in the field
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const isPick = view.kind === 'pick';
  const listVisible = view.visible && isPick && view.items.length > 0;
  const message = view.message;
  const hidden = view.total > view.items.length ? view.total - view.items.length : 0;

  return (
    <>
      {view.visible && (
        <div
          className="qi-backdrop"
          onPointerDown={(e) => {
            // A click outside cancels. Leave focus where the person clicked.
            if (e.target === e.currentTarget) quickInput.cancel({ restoreFocus: false });
          }}
        >
          <div className="qi-panel" role="dialog" aria-label={view.ariaLabel} aria-modal="false">
            {view.title && <div className="qi-title">{view.title}</div>}
            {view.prompt && <div className="qi-prompt">{view.prompt}</div>}
            <div className="qi-field">
              <input
                ref={inputRef}
                className="ui-input qi-input"
                type={view.password ? 'password' : 'text'}
                role={isPick ? 'combobox' : undefined}
                aria-label={view.ariaLabel}
                aria-expanded={isPick ? listVisible : undefined}
                aria-controls={isPick ? listId : undefined}
                aria-activedescendant={
                  listVisible && view.activeIndex >= 0
                    ? `${listId}-opt-${view.activeIndex}`
                    : undefined
                }
                aria-autocomplete={isPick ? 'list' : undefined}
                aria-describedby={statusId}
                aria-invalid={message?.tone === 'error' || undefined}
                placeholder={view.placeholder}
                value={view.value}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                onChange={(e) => quickInput.setValue(e.target.value)}
                onKeyDown={onKeyDown}
              />
              {view.loading && <Spinner size={14} label="" className="qi-spinner" />}
            </div>
            <div
              id={statusId}
              className={cx('qi-status', message && `is-${message.tone}`)}
              role="status"
              aria-live="polite"
            >
              {message ? (
                <>
                  {message.tone === 'error' && <Icon name="alert-circle" size={14} />}
                  <span>{message.text}</span>
                </>
              ) : (
                view.status && <span>{view.status}</span>
              )}
            </div>
            {isPick && (
              <div
                ref={listRef}
                id={listId}
                className="qi-list"
                role="listbox"
                aria-label={view.ariaLabel}
                hidden={!listVisible}
              >
                {view.items.slice(0, MAX_RESULTS).map((item, index) => {
                  const previous = view.items[index - 1];
                  return (
                    <div key={item.id} role="none">
                      {item.group && item.group !== previous?.group && (
                        <div className="group-header" role="presentation">
                          {item.group}
                        </div>
                      )}
                      <Row
                        item={item}
                        index={index}
                        active={index === view.activeIndex}
                        current={view.currentIds.has(item.id)}
                        listId={listId}
                      />
                    </div>
                  );
                })}
                {hidden > 0 && (
                  <div className="qi-more" role="presentation">
                    {hidden.toLocaleString('en-US')} more results. Keep typing to narrow them.
                  </div>
                )}
              </div>
            )}
            {isPick && view.items.length === 0 && !view.loading && !message && view.emptyText && (
              <div className="qi-empty">{view.emptyText}</div>
            )}
          </div>
        </div>
      )}
      {hint && (
        <div className="chord-hint" role="status" aria-live="polite">
          {hint}
        </div>
      )}
    </>
  );
}
