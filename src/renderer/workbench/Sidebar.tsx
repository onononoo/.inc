import type { SidebarView } from '../contracts/layout';
import { Explorer } from '../explorer/Explorer';
import { ScmView } from '../scm/ScmView';
import { SearchView } from '../search/SearchView';
import { useLayoutStore } from '../state/layout-store';
import { ErrorBoundary } from '../ui/ErrorBoundary';

const TITLES: Record<SidebarView, string> = {
  explorer: 'Explorer',
  search: 'Search',
  git: 'Source control',
};

/**
 * The sidebar hosts the three views. All of them stay mounted (hidden when not shown) so scroll
 * position, typed queries and results survive switching views.
 */
export function Sidebar() {
  const view = useLayoutStore((s) => s.sidebarView);
  return (
    <aside id="wb-sidebar" className="wb-sidebar" data-region="sidebar" aria-label={TITLES[view]}>
      <div className="wb-view-title">{TITLES[view]}</div>
      <div className="wb-view" hidden={view !== 'explorer'}>
        <ErrorBoundary region="Explorer">
          <Explorer />
        </ErrorBoundary>
      </div>
      <div className="wb-view" hidden={view !== 'search'}>
        <ErrorBoundary region="Search">
          <SearchView />
        </ErrorBoundary>
      </div>
      <div className="wb-view" hidden={view !== 'git'}>
        <ErrorBoundary region="Source control">
          <ScmView />
        </ErrorBoundary>
      </div>
    </aside>
  );
}
