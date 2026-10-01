import { MENU_NAMES, type MenuName } from '@shared/api/window';
import { ipc, isMac } from '../services/ipc';
import { service } from '../services/registry';
import { useWorkspace } from '../state/workspace-store';
import { Icon } from '../ui/Icon';
import { useRovingTabindex } from '../ui/roving';
import { usePolicy } from '../state/policy-store';

/** The menus that make sense for the current policy (no Terminal menu when the terminal is off). */
function visibleMenus(terminalEnabled: boolean): readonly MenuName[] {
  return MENU_NAMES.filter((name) => name !== 'Terminal' || terminalEnabled);
}

/**
 * 36px title bar: wordmark, the menu labels (Windows and Linux draw their own menu bar; macOS
 * uses the native one), a command centre that opens quick open, and room for the native window
 * controls the operating system draws over the right edge.
 */
export function TitleBar() {
  const workspace = useWorkspace();
  const policy = usePolicy();
  const { ref, onKeyDown, onFocus } = useRovingTabindex<HTMLDivElement>({
    orientation: 'horizontal',
  });

  const openMenu = (name: MenuName, button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    void ipc.invoke('window:showMenu', name, rect.left, rect.bottom);
  };

  return (
    <header className="wb-titlebar" data-platform={isMac ? 'mac' : 'other'}>
      <div className="wb-brand" aria-label=".inc">
        <span className="wb-brand-dot" aria-hidden="true" />
        <span className="wb-brand-name">.inc</span>
      </div>

      {!isMac && (
        <div
          className="wb-menubar"
          role="menubar"
          aria-label="Application menu"
          ref={ref}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
        >
          {visibleMenus(policy.features.terminal).map((name) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              data-roving=""
              className="wb-menu-label"
              onClick={(e) => openMenu(name, e.currentTarget)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  openMenu(name, e.currentTarget);
                }
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="wb-center">
        <button
          type="button"
          className="wb-command-center"
          aria-label="Search files and commands"
          onClick={() => service('quickInput').showQuickOpen('')}
        >
          <Icon name="search" size={14} />
          <span className="wb-command-center-text">{workspace ? workspace.name : '.inc'}</span>
        </button>
      </div>

      <div className="wb-titlebar-end" aria-hidden="true" />
    </header>
  );
}
