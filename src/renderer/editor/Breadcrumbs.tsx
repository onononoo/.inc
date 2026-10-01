import { Fragment } from 'react';
import { describeError } from '@shared/errors';
import { dirname, join, relativeTo, segments } from '@shared/paths';
import type { MenuItem } from '../contracts/layout';
import { ipc, platform } from '../services/ipc';
import { service } from '../services/registry';
import { useWorkspace } from '../state/workspace-store';
import { Icon } from '../ui/Icon';

interface Crumb {
  name: string;
  /** Folder whose entries the dropdown lists (for the file itself, its parent folder). */
  folder: string;
  path: string;
  isFile: boolean;
}

/** Path segments below the workspace root, or the last few segments of a file outside it. */
function crumbsFor(path: string, root: string | null): Crumb[] {
  const rel = root ? relativeTo(root, path, platform as never) : null;
  const base = rel !== null && root ? root : dirname(path);
  const parts = rel !== null ? segments(rel) : segments(path.slice(base.length)).slice(-1);
  const crumbs: Crumb[] = [];
  let current = base;
  parts.forEach((name, index) => {
    const isFile = index === parts.length - 1;
    const folder = current;
    current = join(current, name);
    crumbs.push({ name, folder, path: current, isFile });
  });
  return crumbs;
}

async function listFolder(folder: string, current: string, depth = 0): Promise<MenuItem[]> {
  const entries = await ipc.invoke('fs:readDir', folder);
  const items: MenuItem[] = entries.slice(0, 400).map((entry) => ({
    id: entry.path,
    label: entry.name,
    checked: entry.path === current,
    run: () => {
      if (entry.kind === 'file') {
        void service('commands').execute('editor.openFile', { path: entry.path });
      } else {
        void showFolder(entry.path, current, depth + 1);
      }
    },
  }));
  return items;
}

let lastAnchor = { x: 0, y: 0 };

async function showFolder(folder: string, current: string, depth = 0): Promise<void> {
  try {
    const items = await listFolder(folder, current, depth);
    if (items.length === 0) {
      service('notifications').info('This folder is empty.');
      return;
    }
    await service('menus').show(items, lastAnchor);
  } catch (error) {
    service('notifications').error('Could not list the folder.', describeError(error));
  }
}

/** The path of the open file, one button per segment; each lists its siblings and opens a choice. */
export function Breadcrumbs({ path }: { path: string }) {
  const workspace = useWorkspace();
  const crumbs = crumbsFor(path, workspace?.root ?? null);
  if (crumbs.length === 0) return null;
  return (
    <nav className="eg-breadcrumbs" aria-label="Breadcrumbs">
      {crumbs.map((crumb, index) => (
        <Fragment key={crumb.path}>
          {index > 0 && <Icon name="chevron-right" size={12} className="eg-crumb-sep" />}
          <button
            type="button"
            className="eg-crumb"
            aria-haspopup="menu"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              lastAnchor = { x: rect.left, y: rect.bottom };
              void showFolder(crumb.isFile ? crumb.folder : crumb.path, path);
            }}
          >
            {crumb.name}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
