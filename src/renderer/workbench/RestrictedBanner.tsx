import { useState } from 'react';
import { describeError } from '@shared/errors';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { useWorkspace } from '../state/workspace-store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';

/**
 * Shown under the title bar while the open folder is not trusted. It says what is switched off and
 * offers the two ways forward. Dismissing it only hides it for this folder in this window.
 */
export function RestrictedBanner() {
  const workspace = useWorkspace();
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!workspace || workspace.trust !== 'untrusted' || dismissedFor === workspace.root) return null;

  const trust = async () => {
    setBusy(true);
    try {
      await ipc.invoke('workspace:setTrust', true);
    } catch (error) {
      service('notifications').error('Could not trust this folder.', describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wb-banner is-warning" role="region" aria-label="Restricted Mode">
      <Icon name="shield-alert" className="wb-banner-icon" />
      <p className="wb-banner-text">
        <strong>Restricted Mode.</strong> The terminal, tasks and workspace settings that can run
        code are turned off until you trust this folder.
      </p>
      <Button size="sm" variant="primary" busy={busy} onClick={() => void trust()}>
        Trust folder
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void service('commands').execute('settings.manageTrust')}
      >
        Manage
      </Button>
      <IconButton icon="close" label="Dismiss" onClick={() => setDismissedFor(workspace.root)} />
    </div>
  );
}
