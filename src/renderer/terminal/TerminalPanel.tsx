import { useEffect, useRef } from 'react';
import { useResizeObserver } from '../ui/use-resize-observer';
import type { MenuItem } from '../contracts/layout';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { useResolvedTheme } from '../workbench/theme';
import { useSettingsStore } from '../state/settings-store';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { cx } from '../ui/cx';
import {
  clearTerminal,
  closeTerminal,
  copySelection,
  createTerminal,
  focusTerminal,
  hasSelection,
  loadProfiles,
  mountTerminal,
  pasteFromClipboard,
  refreshAppearance,
  resizeTerminal,
  restartTerminal,
  selectAll,
  setActive,
  useTerminals,
} from './terminal-controller';
import './terminal.css';

function profileMenu(): void {
  void loadProfiles().then((profiles) => {
    const items: MenuItem[] = profiles.map((p) => ({
      id: p.id,
      label: p.isDefault ? `${p.label} (default)` : p.label,
      run: () => void createTerminal({ profileId: p.id }),
    }));
    const button = document.querySelector<HTMLElement>('[data-testid="terminal-profiles"]');
    const rect = button?.getBoundingClientRect();
    void service('menus').show(items, { x: rect?.left ?? 0, y: rect?.bottom ?? 0 });
  });
}

/** The integrated terminal: a tab strip of shells, each an xterm that stays alive while hidden. */
export function TerminalPanel() {
  const state = useTerminals();
  const theme = useResolvedTheme();
  const host = useRef<HTMLDivElement>(null);
  const active = state.terminals.find((t) => t.id === state.activeId);

  // Move each terminal's element into the host and show the active one.
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    for (const entry of state.terminals) mountTerminal(entry.id, container);
    for (const child of Array.from(container.children)) {
      const id = Number((child as HTMLElement).dataset.terminalId);
      (child as HTMLElement).hidden = id !== state.activeId;
    }
    if (state.activeId !== null) resizeTerminal(state.activeId);
  }, [state.terminals, state.activeId]);

  // Colours and fonts follow the theme and the settings.
  useEffect(() => {
    requestAnimationFrame(refreshAppearance);
  }, [theme]);
  useEffect(() => useSettingsStore.subscribe(refreshAppearance), []);

  useResizeObserver(host, () => {
    if (state.activeId !== null) resizeTerminal(state.activeId);
  });

  const showMenu = (event: { clientX: number; clientY: number }) => {
    if (!active) return;
    const items: MenuItem[] = [
      {
        id: 'copy',
        label: 'Copy',
        disabled: !hasSelection(active.id),
        run: () => void copySelection(active.id),
      },
      { id: 'paste', label: 'Paste', run: () => void pasteFromClipboard(active.id) },
      { id: 'all', label: 'Select all', separatorBefore: true, run: () => selectAll(active.id) },
      { id: 'clear', label: 'Clear', run: () => clearTerminal(active.id) },
    ];
    void service('menus').show(items, { x: event.clientX, y: event.clientY });
  };

  if (state.blocked) {
    return (
      <div className="term-state" data-testid="terminal-blocked">
        <EmptyState
          title={
            state.blocked.kind === 'policy'
              ? 'The terminal is turned off'
              : 'The terminal is in Restricted Mode'
          }
          description={state.blocked.message}
          action={
            state.blocked.kind === 'untrusted' ? (
              <Button variant="primary" onClick={() => void ipc.invoke('workspace:setTrust', true)}>
                Trust folder
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <div className="term" data-testid="terminal-panel">
      <div className="term-bar">
        <div className="term-tabs" role="tablist" aria-label="Terminals">
          {state.terminals.map((entry) => (
            <div
              key={entry.id}
              role="tab"
              aria-selected={entry.id === state.activeId}
              tabIndex={entry.id === state.activeId ? 0 : -1}
              className={cx(
                'term-tab',
                entry.id === state.activeId && 'is-active',
                entry.exit && 'is-exited',
              )}
              onClick={() => {
                setActive(entry.id);
                focusTerminal(entry.id);
              }}
              onAuxClick={(e) => e.button === 1 && void closeTerminal(entry.id)}
            >
              <Icon name="terminal" size={14} />
              <span className="term-tab-label">{entry.title || entry.name}</span>
              <button
                type="button"
                className="term-tab-close"
                aria-label={`Close ${entry.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTerminal(entry.id);
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
        <div className="term-actions">
          <IconButton
            icon="plus"
            label="New terminal"
            shortcut={service('keybindings').labelFor('terminal.new')}
            onClick={() => void createTerminal()}
          />
          <IconButton
            icon="chevron-down"
            label="Choose a shell"
            data-testid="terminal-profiles"
            onClick={profileMenu}
          />
          <IconButton
            icon="trash"
            label="Kill terminal"
            disabled={!active}
            onClick={() => active && void closeTerminal(active.id)}
          />
          <IconButton
            icon="reset"
            label="Clear terminal"
            disabled={!active}
            onClick={() => active && clearTerminal(active.id)}
          />
        </div>
      </div>
      {active && !active.isPty && (
        <div className="term-note" role="status">
          <Icon name="info" size={14} />
          <span>
            {active.fallbackReason ?? 'Basic terminal: full-screen programs are not supported.'}
          </span>
        </div>
      )}
      <div
        className="term-body"
        onContextMenu={(e) => {
          e.preventDefault();
          showMenu(e);
        }}
      >
        <div ref={host} className="term-hosts" data-testid="terminal-hosts" />
        {state.terminals.length === 0 && (
          <div className="term-state">
            {state.error ? (
              <EmptyState
                title="The terminal could not start"
                description={state.error}
                action={<Button onClick={() => void createTerminal()}>Try again</Button>}
              />
            ) : (
              <EmptyState
                title="No terminal is open"
                description="Open a terminal to run commands in this folder."
                action={
                  <Button variant="primary" onClick={() => void createTerminal()}>
                    New terminal
                  </Button>
                }
              />
            )}
          </div>
        )}
        {active?.exit && (
          <div className="term-exited" role="status">
            <span>
              Process exited{active.exit.code === null ? '' : ` with code ${active.exit.code}`}.
            </span>
            <Button size="sm" onClick={() => void restartTerminal(active.id)}>
              Restart
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void closeTerminal(active.id)}>
              Close
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
