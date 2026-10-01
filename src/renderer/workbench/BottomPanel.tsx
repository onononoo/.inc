import type { PanelView } from '../contracts/layout';
import { ProblemsPanel } from '../editor/ProblemsPanel';
import { service } from '../services/registry';
import { useLayoutStore } from '../state/layout-store';
import { useProblemCounts } from '../state/problems-store';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { Badge } from '../ui/Badge';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { IconButton } from '../ui/IconButton';
import { Tabs, tabId, tabPanelId, type TabItem } from '../ui/Tabs';
import { usePolicy } from '../state/policy-store';

const PREFIX = 'wb-panel';

/** Terminal and Problems. Both stay mounted so a running shell and the problem list keep their state. */
export function BottomPanel() {
  const view = useLayoutStore((s) => s.panelView);
  const errors = useProblemCounts((s) => s.errors);
  const warnings = useProblemCounts((s) => s.warnings);
  const policy = usePolicy();
  const total = errors + warnings;

  const items: TabItem[] = [
    ...(policy.features.terminal ? [{ id: 'terminal', label: 'Terminal' }] : []),
    {
      id: 'problems',
      label: 'Problems',
      badge:
        total > 0 ? (
          <Badge label={`${errors} errors, ${warnings} warnings`}>
            {total > 999 ? '999+' : total}
          </Badge>
        ) : undefined,
    },
  ];
  const shown: PanelView = items.some((i) => i.id === view) ? view : 'problems';

  return (
    <section id="wb-panel" className="wb-panel" data-region="panel" aria-label="Panel">
      <div className="wb-panel-header">
        <Tabs
          items={items}
          value={shown}
          label="Panel views"
          idPrefix={PREFIX}
          onChange={(id) => service('layout').showPanel(id as PanelView, { focus: false })}
        />
        <div className="wb-panel-actions">
          <IconButton
            icon="close"
            label="Close panel"
            shortcut={service('keybindings').labelFor('view.toggleBottomPanel')}
            onClick={() => service('layout').togglePanel()}
          />
        </div>
      </div>
      <div
        className="wb-panel-body"
        role="tabpanel"
        id={tabPanelId(PREFIX, 'terminal')}
        aria-labelledby={tabId(PREFIX, 'terminal')}
        hidden={shown !== 'terminal'}
      >
        <ErrorBoundary region="Terminal">
          <TerminalPanel />
        </ErrorBoundary>
      </div>
      <div
        className="wb-panel-body"
        role="tabpanel"
        id={tabPanelId(PREFIX, 'problems')}
        aria-labelledby={tabId(PREFIX, 'problems')}
        hidden={shown !== 'problems'}
      >
        <ErrorBoundary region="Problems">
          <ProblemsPanel />
        </ErrorBoundary>
      </div>
    </section>
  );
}
