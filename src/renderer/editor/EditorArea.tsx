import { Fragment, useEffect, useRef, useState } from 'react';
import { service } from '../services/registry';
import { EmptyState } from '../ui/EmptyState';
import { Kbd } from '../ui/Kbd';
import { Splitter } from '../ui/Splitter';
import { cx } from '../ui/cx';
import { DocumentBanners } from './Banners';
import { Breadcrumbs } from './Breadcrumbs';
import { CodeEditor } from './CodeEditor';
import { DiffView } from './DiffView';
import { BinaryPlaceholder, ImagePreview, TooLargePlaceholder, isImagePath } from './Placeholders';
import { TabStrip } from './TabStrip';
import { useCustomEditors } from './editor-requests';
import { useDocumentInfo } from './documents-store';
import { activeTab, setActiveGroup, type Group } from './groups-model';
import { updateGroups, useGroups } from './groups-store';
import { setEditorStatus } from './status-store';
import './editor.css';

function NoEditor() {
  const keys = service('keybindings').labelFor('palette.quickOpen');
  return (
    <div className="eg-empty">
      <EmptyState
        title="No editor is open"
        description="Open a file from the explorer, or search for one by name."
        hint={undefined}
        action={keys ? <Kbd keys={keys} /> : undefined}
      />
    </div>
  );
}

function CustomTab({ group }: { group: Group }) {
  const components = useCustomEditors((s) => s.components);
  const tab = activeTab(group);
  if (!tab || tab.input.kind !== 'custom') return null;
  const Component = components[tab.input.input.kind];
  if (!Component) return <NoEditor />;
  return <Component input={tab.input.input} />;
}

/** One editor group: tab strip, breadcrumbs, banners and the active tab's content. */
function GroupView({ group, active, width }: { group: Group; active: boolean; width?: number }) {
  const tab = activeTab(group);
  const fileKey = tab?.input.kind === 'file' ? tab.input.key : undefined;
  const doc = useDocumentInfo(fileKey);
  const showsText = !!doc && doc.kind === 'text';
  const image = !!doc && doc.kind === 'binary' && isImagePath(doc.path);

  useEffect(() => {
    if (active && !showsText) setEditorStatus(null);
  }, [active, showsText]);

  return (
    <section
      className={cx('eg-group', active && 'is-active')}
      style={width ? { width, flex: 'none' } : undefined}
      aria-label={`Editor group ${group.id}`}
      data-group-id={group.id}
      onPointerDown={() => updateGroups((state) => setActiveGroup(state, group.id))}
    >
      <TabStrip group={group} groupActive={active} />
      {doc?.path && tab?.input.kind === 'file' && <Breadcrumbs path={doc.path} />}
      {doc && tab?.input.kind === 'file' && <DocumentBanners doc={doc} />}
      <div className="eg-content">
        <div className="eg-code-wrap" hidden={!showsText}>
          <CodeEditor groupId={group.id} doc={showsText ? doc : null} groupActive={active} />
        </div>
        {doc?.kind === 'binary' && !image && <BinaryPlaceholder doc={doc} />}
        {doc?.kind === 'binary' && image && <ImagePreview doc={doc} />}
        {doc?.kind === 'tooLarge' && <TooLargePlaceholder doc={doc} />}
        {tab?.input.kind === 'diff' && (
          <DiffView key={tab.id} tabId={tab.id} diff={tab.input.diff} />
        )}
        {tab?.input.kind === 'custom' && <CustomTab group={group} />}
        {!tab && <NoEditor />}
      </div>
    </section>
  );
}

/** The editor area: one group, or two side by side with a splitter. */
export function EditorArea() {
  const groups = useGroups((s) => s.groups);
  const activeGroupId = useGroups((s) => s.activeGroupId);
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setTotal(element.clientWidth));
    observer.observe(element);
    setTotal(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const first = groups.length > 1 ? Math.round(width ?? total / 2) : undefined;
  const min = 240;
  const max = Math.max(min, total - min);

  return (
    <div className="eg-area" ref={holder} data-testid="editor-area">
      {groups.map((group, index) => (
        <Fragment key={group.id}>
          {index === 1 && (
            <Splitter
              orientation="vertical"
              label="Resize editor groups"
              size={Math.min(Math.max(first ?? 0, min), max)}
              min={min}
              max={max}
              defaultSize={Math.round(total / 2)}
              onChange={setWidth}
            />
          )}
          <GroupView
            group={group}
            active={group.id === activeGroupId}
            width={
              index === 0 && groups.length > 1
                ? Math.min(Math.max(first ?? 0, min), max)
                : undefined
            }
          />
        </Fragment>
      ))}
    </div>
  );
}
