import type { SidebarView } from '../contracts/layout';
import { service } from '../services/registry';
import { useGitStore } from '../scm/git-store';
import { useLayoutStore } from '../state/layout-store';
import { IconButton } from '../ui/IconButton';
import { useRovingTabindex } from '../ui/roving';

interface ActivityItem {
  view: SidebarView;
  label: string;
  icon: string;
  command: string;
}

const VIEWS: readonly ActivityItem[] = [
  { view: 'explorer', label: 'Explorer', icon: 'files', command: 'view.showExplorer' },
  { view: 'search', label: 'Search', icon: 'search', command: 'view.showSearch' },
  { view: 'git', label: 'Source control', icon: 'source-control', command: 'view.showGit' },
];

/** Count of changed files, shown as a badge on the source control button. */
function useChangeCount(): number {
  return useGitStore((s) => (s.status ? s.status.totalChanged : 0));
}

function formatCount(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * The 48px view switcher. Choosing the view that is already showing hides the sidebar. Arrow keys
 * move between the buttons (one tab stop), and each button's tooltip carries its shortcut.
 */
export function ActivityBar() {
  const visible = useLayoutStore((s) => s.sidebarVisible);
  const active = useLayoutStore((s) => s.sidebarView);
  const changes = useChangeCount();
  const { ref, onKeyDown, onFocus } = useRovingTabindex<HTMLDivElement>({
    orientation: 'vertical',
  });
  const labelFor = (command: string) => service('keybindings').labelFor(command);

  const choose = (item: ActivityItem) => {
    const layout = service('layout');
    if (visible && active === item.view) layout.toggleSidebar();
    else layout.showSidebar(item.view, { focus: false });
  };

  return (
    <nav className="wb-activitybar" aria-label="Views">
      <div
        className="wb-activity-group"
        role="toolbar"
        aria-orientation="vertical"
        aria-label="Primary views"
        ref={ref}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
      >
        {VIEWS.map((item) => (
          <div className="wb-activity-item" key={item.view}>
            <IconButton
              size="lg"
              icon={item.icon}
              label={item.label}
              shortcut={labelFor(item.command)}
              pressed={visible && active === item.view}
              tooltipPlacement="right"
              data-roving=""
              data-testid={`activity-${item.view}`}
              onClick={() => choose(item)}
            />
            {item.view === 'git' && changes > 0 && (
              <span
                className="ui-badge ui-badge-count ui-badge-accent wb-activity-badge"
                role="img"
                aria-label={`${changes} changed ${changes === 1 ? 'file' : 'files'}`}
              >
                {formatCount(changes)}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="wb-activity-group wb-activity-bottom">
        <IconButton
          size="lg"
          icon="settings"
          label="Settings"
          shortcut={labelFor('settings.open')}
          tooltipPlacement="right"
          data-testid="activity-settings"
          onClick={() => void service('commands').execute('settings.open')}
        />
      </div>
    </nav>
  );
}
