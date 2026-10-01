import { useEffect, useState } from 'react';
import type { RecentWorkspace } from '@shared/api/workspace';
import type { CustomEditorProps } from '../contracts/editor';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Kbd } from '../ui/Kbd';

function Shortcut({ label, command }: { label: string; command: string }) {
  const keys = service('keybindings').labelFor(command);
  return (
    <li className="welcome-shortcut">
      <span>{label}</span>
      {keys && <Kbd keys={keys} />}
    </li>
  );
}

/** The page that opens when there is nothing to restore: start actions, recent folders, shortcuts. */
export function Welcome(_props: CustomEditorProps) {
  const [recent, setRecent] = useState<RecentWorkspace[]>([]);
  const commands = service('commands');

  const load = () =>
    void ipc
      .invoke('workspace:getRecent')
      .then(setRecent)
      .catch(() => setRecent([]));
  useEffect(load, []);

  const open = (path: string) => void commands.execute('file.openFolder', { path });
  const remove = (path: string) =>
    void ipc
      .invoke('workspace:removeRecent', path)
      .then(setRecent)
      .catch(() => undefined);

  return (
    <div className="welcome" data-testid="welcome">
      <div className="welcome-inner">
        <h1 className="welcome-title">
          <span className="welcome-dot" aria-hidden="true" />
          .inc
        </h1>

        <section aria-labelledby="welcome-start">
          <h2 id="welcome-start" className="welcome-heading">
            Start
          </h2>
          <div className="welcome-actions">
            <Button
              variant="primary"
              icon="folder-open"
              onClick={() => void commands.execute('file.openFolder')}
            >
              Open folder
            </Button>
            <Button icon="file" onClick={() => void commands.execute('file.openFile')}>
              Open file
            </Button>
          </div>
        </section>

        <section aria-labelledby="welcome-recent">
          <h2 id="welcome-recent" className="welcome-heading">
            Recent
          </h2>
          {recent.length === 0 ? (
            <p className="welcome-muted">Folders you open appear here.</p>
          ) : (
            <ul className="welcome-recent">
              {recent.slice(0, 8).map((item) => (
                <li key={item.path} className="welcome-recent-item">
                  <button
                    type="button"
                    className="welcome-recent-open"
                    onClick={() => open(item.path)}
                  >
                    <span className="welcome-recent-name">{item.name}</span>
                    <span className="welcome-recent-path">{item.path}</span>
                  </button>
                  <IconButton
                    icon="close"
                    label={`Remove ${item.name} from recent`}
                    onClick={() => remove(item.path)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="welcome-shortcuts">
          <h2 id="welcome-shortcuts" className="welcome-heading">
            Shortcuts
          </h2>
          <ul className="welcome-shortcuts">
            <Shortcut label="Command palette" command="palette.commands" />
            <Shortcut label="Go to file" command="palette.quickOpen" />
            <Shortcut label="Search in files" command="search.findInFiles" />
            <Shortcut label="Toggle terminal" command="terminal.toggle" />
          </ul>
        </section>
      </div>
    </div>
  );
}
