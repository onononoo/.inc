import { QuickInputHost } from '../commands/QuickInputHost';
import { EditorArea } from '../editor/EditorArea';
import {
  PANEL_DEFAULT,
  PANEL_MIN,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  setPanelHeight,
  setSidebarWidth,
  useLayoutStore,
} from '../state/layout-store';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Splitter } from '../ui/Splitter';
import { useViewportSize } from '../ui/hooks';
import { ActivityBar } from './ActivityBar';
import { BottomPanel } from './BottomPanel';
import { DialogHost, MenuHost, ToastHost } from './Hosts';
import { RestrictedBanner } from './RestrictedBanner';
import { Sidebar } from './Sidebar';
import { StatusBar } from './StatusBar';
import { TitleBar } from './TitleBar';
import './workbench.css';

/** Height the editor keeps when the panel is dragged as tall as it can go. */
const MIN_EDITOR_HEIGHT = 160;
const TITLEBAR = 36;
const STATUSBAR = 24;

/**
 * The window layout: title bar, activity bar, sidebar, editor area with a resizable bottom panel,
 * and the status bar. The sidebar and panel stay mounted while hidden so their views keep state.
 */
export function Workbench() {
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible);
  const sidebarWidth = useLayoutStore((s) => s.sidebarWidth);
  const panelVisible = useLayoutStore((s) => s.panelVisible);
  const panelHeight = useLayoutStore((s) => s.panelHeight);
  const viewport = useViewportSize();

  const sidebarMax = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(viewport.width / 2)));
  const panelMax = Math.max(PANEL_MIN, viewport.height - TITLEBAR - STATUSBAR - MIN_EDITOR_HEIGHT);
  const width = Math.min(Math.max(sidebarWidth, SIDEBAR_MIN), sidebarMax);
  const height = Math.min(Math.max(panelHeight, PANEL_MIN), panelMax);

  return (
    <div className="workbench">
      <TitleBar />
      <RestrictedBanner />
      <div className="wb-body">
        <ActivityBar />
        <div className="wb-sidebar-wrap" style={{ width }} hidden={!sidebarVisible}>
          <Sidebar />
        </div>
        {sidebarVisible && (
          <Splitter
            orientation="vertical"
            label="Resize sidebar"
            controls="wb-sidebar"
            size={width}
            min={SIDEBAR_MIN}
            max={sidebarMax}
            defaultSize={SIDEBAR_DEFAULT}
            onChange={setSidebarWidth}
          />
        )}
        <main className="wb-main">
          <div className="wb-editor" data-region="editor">
            <ErrorBoundary region="Editor">
              <EditorArea />
            </ErrorBoundary>
          </div>
          {panelVisible && (
            <Splitter
              orientation="horizontal"
              invert
              label="Resize panel"
              controls="wb-panel"
              size={height}
              min={PANEL_MIN}
              max={panelMax}
              defaultSize={PANEL_DEFAULT}
              onChange={(next) => setPanelHeight(next, panelMax)}
            />
          )}
          <div className="wb-panel-wrap" style={{ height }} hidden={!panelVisible}>
            <BottomPanel />
          </div>
        </main>
      </div>
      <StatusBar />
      <QuickInputHost />
      <MenuHost />
      <ToastHost />
      <DialogHost />
    </div>
  );
}
