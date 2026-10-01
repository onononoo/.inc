import type { Disposable, Kernel } from '../kernel';
import { KeybindingsService } from './keybindings-service';
import { PolicyService, resolvePolicyPath } from './policy-service';
import { SettingsService } from './settings-service';

export { KeybindingsService } from './keybindings-service';
export { PolicyService, resolvePolicyPath } from './policy-service';
export { SettingsService } from './settings-service';

/**
 * Settings slice: layered settings service, enterprise policy and keybindings.json.
 * Replaces `kernel.settings` and `kernel.policy`.
 */
export function register(kernel: Kernel): Disposable {
  const resolution = resolvePolicyPath({
    platform: process.platform,
    env: process.env,
    isPackaged: kernel.info.isPackaged,
  });
  if (resolution.ignoredOverride) {
    kernel.logger.warn(
      `INC_POLICY_FILE is ignored in installed builds; reading the policy from ${resolution.file}.`,
    );
  }

  const policy = new PolicyService({ file: resolution.file, logger: kernel.logger });
  kernel.policy = policy;
  // Registered before the settings service subscribes, so a window hears about the policy first.
  const stopPolicyBroadcast = policy.onDidChange((state) =>
    kernel.broadcast('policy:changed', state),
  );

  const settings = new SettingsService({
    userDataDir: kernel.info.userDataDir,
    logger: kernel.logger,
    workspaces: () => kernel.workspaces,
    policy,
    notify: (windowId, snapshot) => kernel.send(windowId, 'settings:changed', snapshot),
  });
  kernel.settings = settings;

  const keybindings = new KeybindingsService({
    userDataDir: kernel.info.userDataDir,
    logger: kernel.logger,
  });
  const stopKeybindingsBroadcast = keybindings.onDidChange((snapshot) =>
    kernel.broadcast('keybindings:changed', snapshot),
  );

  kernel.handle('settings:get', ({ windowId }) => settings.snapshot(windowId));
  kernel.handle('settings:set', ({ windowId }, key, value, scope) =>
    settings.set(windowId, key, value, scope),
  );
  kernel.handle('settings:reset', ({ windowId }, key, scope) =>
    settings.reset(windowId, key, scope),
  );
  kernel.handle('settings:ensureFile', ({ windowId }, scope) =>
    settings.ensureFile(windowId, scope),
  );
  kernel.handle('policy:get', () => policy.state);
  kernel.handle('keybindings:get', () => keybindings.snapshot());
  kernel.handle('keybindings:ensureFile', () => keybindings.ensureFile());

  const subscriptions = [
    // The workspace slice registers after this one; follow its host once windows exist.
    kernel.onWindowCreated(() => settings.attach()),
    kernel.onWindowClosed((windowId) => settings.releaseWindow(windowId)),
  ];

  return () => {
    for (const unsubscribe of subscriptions) unsubscribe();
    stopPolicyBroadcast();
    stopKeybindingsBroadcast();
    settings.dispose();
    keybindings.dispose();
    policy.dispose();
  };
}
