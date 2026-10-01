import type { ThemeSetting } from '@shared/settings';
import { describeError } from '@shared/errors';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { getSetting, setSetting } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { Button } from '../ui/Button';
import { currentTheme, resolveTheme, showTheme } from '../workbench/theme';
import { KeybindingsEditor } from './KeybindingsEditor';
import { ManagedView } from './ManagedView';
import { SettingsEditor } from './SettingsEditor';

const THEMES: { id: ThemeSetting; label: string; description: string }[] = [
  {
    id: 'system',
    label: 'Match system',
    description: 'Light or dark, following your operating system',
  },
  { id: 'light', label: 'Light', description: 'The default light theme' },
  { id: 'dark', label: 'Dark', description: 'The default dark theme' },
  {
    id: 'hc-light',
    label: 'High contrast light',
    description: 'Maximum contrast on a white background',
  },
  {
    id: 'hc-dark',
    label: 'High contrast dark',
    description: 'Maximum contrast on a black background',
  },
];

function showTrustDialog(): void {
  const workspace = useWorkspaceStore.getState().workspace;
  service('dialogs').showCustom(
    (close) => {
      if (!workspace) {
        return (
          <div>
            <p>Open a folder first. Trust is decided for each folder.</p>
            <div className="ui-dialog-actions">
              <Button variant="primary" data-autofocus onClick={close}>
                Close
              </Button>
            </div>
          </div>
        );
      }
      const trusted = workspace.trust === 'trusted';
      const decide = async (value: boolean) => {
        try {
          await ipc.invoke('workspace:setTrust', value);
          close();
        } catch (error) {
          service('notifications').error('Could not change trust.', describeError(error));
        }
      };
      return (
        <div className="trust">
          {!workspace.trustEnabled ? (
            <p>
              Workspace trust is turned off, so every folder is treated as trusted. This is
              controlled by the security.workspaceTrust setting or by your organization.
            </p>
          ) : (
            <>
              <p>
                <strong>{workspace.name}</strong> is {trusted ? 'trusted' : 'in Restricted Mode'}.
              </p>
              <p>Restricted Mode keeps code in this folder from running. While it is on:</p>
              <ul className="trust-list">
                <li>The terminal and tasks are turned off.</li>
                <li>Workspace settings that can run code are ignored.</li>
                <li>
                  Git can only read the repository, and repository configuration cannot run
                  commands.
                </li>
              </ul>
              <p>Trust a folder only when you know where it came from.</p>
            </>
          )}
          <div className="ui-dialog-actions">
            {workspace.trustEnabled &&
              (trusted ? (
                <Button variant="danger" onClick={() => void decide(false)}>
                  Switch to Restricted Mode
                </Button>
              ) : (
                <Button onClick={() => void decide(false)}>Keep restricted</Button>
              ))}
            {workspace.trustEnabled && !trusted && (
              <Button variant="primary" data-autofocus onClick={() => void decide(true)}>
                Trust folder
              </Button>
            )}
            <Button
              data-autofocus={trusted || !workspace.trustEnabled ? true : undefined}
              onClick={close}
            >
              Close
            </Button>
          </div>
        </div>
      );
    },
    { title: 'Manage workspace trust', width: 480 },
  );
}

/** Provides the settings, shortcuts, trust and managed-configuration views and their commands. */
export function register(): void {
  const editor = service('editor');
  const commands = service('commands');
  const run = (id: string, handler: (args?: never) => unknown) => commands.register(id, handler);

  editor.registerCustomEditor('settings', SettingsEditor);
  editor.registerCustomEditor('keybindings', KeybindingsEditor);
  editor.registerCustomEditor('managed', ManagedView);

  run('settings.open', () =>
    editor.openCustom({ kind: 'settings', key: 'settings', title: 'Settings', icon: 'settings' }),
  );
  run('settings.openKeybindings', () =>
    editor.openCustom({
      kind: 'keybindings',
      key: 'keybindings',
      title: 'Keyboard shortcuts',
      icon: 'keyboard',
    }),
  );
  run('settings.showPolicy', () =>
    editor.openCustom({
      kind: 'managed',
      key: 'managed',
      title: 'Managed configuration',
      icon: 'shield',
    }),
  );
  run('settings.manageTrust', showTrustDialog);

  const openFile = async (load: () => Promise<string>) => {
    try {
      await editor.openFile(await load());
    } catch (error) {
      service('notifications').error('Could not open the file.', describeError(error));
    }
  };
  run('settings.openJson', () => openFile(() => ipc.invoke('settings:ensureFile', 'user')));
  run('settings.openWorkspaceJson', () =>
    openFile(() => ipc.invoke('settings:ensureFile', 'workspace')),
  );
  run('settings.openKeybindingsJson', () => openFile(() => ipc.invoke('keybindings:ensureFile')));

  // Choosing a theme previews it as you move through the list and keeps it on Enter.
  run('settings.selectTheme', async () => {
    const original = currentTheme();
    const saved = getSetting('appearance.theme');
    let committed = false;
    const preview = (id: string | undefined) => {
      const theme = THEMES.find((t) => t.id === id);
      if (theme)
        showTheme(
          resolveTheme(theme.id, window.matchMedia('(prefers-color-scheme: dark)').matches),
        );
    };
    const picked = await service('quickInput').pick(
      THEMES.map((t) => ({
        id: t.id,
        label: t.label,
        description: t.description,
        icon: 'palette',
      })),
      {
        placeholder: 'Select a color theme',
        title: 'Color theme',
        activeIds: [saved],
        onActiveChange: (item) => preview(item?.id),
      },
    );
    if (picked) {
      committed = true;
      await setSetting('appearance.theme', picked.id as ThemeSetting).catch((error) =>
        service('notifications').error('Could not change the theme.', describeError(error)),
      );
    }
    if (!committed) showTheme(original);
  });
}
