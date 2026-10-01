import { describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppInfo } from '@shared/api/app';
import type { WorkspaceInfo } from '@shared/api/workspace';
import { IncError } from '@shared/errors';
import type { InvokeChannel } from '@shared/ipc';
import { EMPTY_POLICY, type PolicyState } from '@shared/policy';
import {
  Emitter,
  createDefaultSettingsHost,
  createDefaultWorkspaceHost,
  type Handler,
  type Kernel,
} from '../../../src/main/kernel';
import { register } from '../../../src/main/workspace';
import { hostPlatform, recordingLogger, tempDir } from './helpers';

vi.mock('electron', () => ({
  app: { addRecentDocument: vi.fn(), clearRecentDocuments: vi.fn() },
}));

const CHANNELS: InvokeChannel[] = [
  'workspace:get',
  'workspace:open',
  'workspace:close',
  'workspace:setTrust',
  'workspace:getRecent',
  'workspace:removeRecent',
  'workspace:clearRecent',
  'session:load',
  'session:save',
];

function harness() {
  const userDataDir = tempDir();
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sent: { windowId: number; channel: string; payload: unknown }[] = [];
  const settingChanges = new Emitter<{ windowId: number | null; keys: string[] }>();
  const policyChanges = new Emitter<PolicyState>();
  const closed = new Emitter<number>();
  let trustSetting = true;
  let policy: PolicyState = EMPTY_POLICY;

  const kernel: Kernel = {
    info: { userDataDir, platform: hostPlatform } as AppInfo,
    logger: recordingLogger(),
    settings: {
      ...createDefaultSettingsHost(),
      get: ((_id: number | null, key: string) =>
        key === 'security.workspaceTrust' ? trustSetting : undefined) as never,
      onDidChange: (cb) => settingChanges.on(cb as never),
    },
    policy: {
      get state() {
        return policy;
      },
      onDidChange: (cb) => policyChanges.on(cb),
    },
    workspaces: createDefaultWorkspaceHost(),
    fsChanges: new Emitter(),
    handle<K extends InvokeChannel>(channel: K, handler: Handler<K>) {
      handlers.set(channel, (...args: unknown[]) =>
        (handler as (...a: unknown[]) => unknown)({ windowId: 1 }, ...args),
      );
    },
    send: ((windowId: number, channel: string, payload: unknown) =>
      void sent.push({ windowId, channel, payload })) as Kernel['send'],
    broadcast: () => undefined,
    getWindow: () => ({}) as never,
    getWindowIds: () => [1],
    onWindowCreated: () => () => undefined,
    onWindowClosed: (cb) => closed.on(cb),
  };

  const dispose = register(kernel);
  return {
    kernel,
    handlers,
    sent,
    dispose,
    // Like the kernel, always settle asynchronously so a synchronous throw becomes a rejection.
    call: async (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args),
    setTrustSetting(value: boolean) {
      trustSetting = value;
      settingChanges.emit({ windowId: null, keys: ['security.workspaceTrust'] });
    },
    setPolicy(next: PolicyState) {
      policy = next;
      policyChanges.emit(next);
    },
    closeWindow: (id: number) => closed.emit(id),
  };
}

function folder(name: string): string {
  const dir = path.join(tempDir(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('workspace slice registration', () => {
  it('registers every workspace and session channel and replaces the default host', () => {
    const h = harness();
    for (const channel of CHANNELS) expect(h.handlers.has(channel), channel).toBe(true);
    expect(h.kernel.workspaces.getRoot(1)).toBeNull();
    h.dispose();
  });

  it('serves the channels end to end through the kernel host', async () => {
    const h = harness();
    const dir = folder('repo');
    const info = (await h.call('workspace:open', dir)) as WorkspaceInfo;
    expect(info.trust).toBe('untrusted');
    expect(h.kernel.workspaces.getRoot(1)).toBe(dir);
    expect(h.kernel.workspaces.isTrusted(1)).toBe(false);
    expect(h.sent.at(-1)).toEqual({ windowId: 1, channel: 'workspace:changed', payload: info });

    const trusted = (await h.call('workspace:setTrust', true)) as WorkspaceInfo;
    expect(trusted.trust).toBe('trusted');
    expect(h.kernel.workspaces.isTrusted(1)).toBe(true);
    await expect(h.call('workspace:open', path.join(dir, 'missing'))).rejects.toMatchObject({
      code: 'E_NOT_FOUND',
    });
    h.dispose();
  });

  it('re-announces open windows when the trust setting changes', async () => {
    const h = harness();
    await h.call('workspace:open', folder('repo'));
    const before = h.sent.length;
    h.setTrustSetting(false);
    expect(h.sent.length).toBe(before + 1);
    expect(h.sent.at(-1)!.payload).toMatchObject({ trust: 'trusted', trustEnabled: false });
    expect(h.kernel.workspaces.isTrusted(1)).toBe(true);
    h.dispose();
  });

  it('lets policy override the user setting and re-announces on policy changes', async () => {
    const h = harness();
    await h.call('workspace:open', folder('repo'));
    h.setPolicy({
      ...EMPTY_POLICY,
      active: true,
      lockedKeys: ['security.workspaceTrust'],
      values: { 'security.workspaceTrust': false },
    });
    expect(h.sent.at(-1)!.payload).toMatchObject({ trust: 'trusted', trustEnabled: false });
    h.setPolicy(EMPTY_POLICY);
    expect(h.sent.at(-1)!.payload).toMatchObject({ trust: 'untrusted', trustEnabled: true });
    h.dispose();
  });

  it('forgets a window when it closes but keeps the folder to restore', async () => {
    const h = harness();
    const dir = folder('repo');
    await h.call('workspace:open', dir);
    h.closeWindow(1);
    expect(h.kernel.workspaces.getRoot(1)).toBeNull();
    expect(h.kernel.workspaces.getLastOpened()).toBe(dir);
    h.dispose();
  });

  it('stops listening after dispose', async () => {
    const h = harness();
    await h.call('workspace:open', folder('repo'));
    h.dispose();
    const before = h.sent.length;
    h.setTrustSetting(false);
    expect(h.sent.length).toBe(before);
  });

  it('reports typed errors from handlers', async () => {
    const h = harness();
    await expect(h.call('workspace:setTrust', true)).rejects.toBeInstanceOf(IncError);
    h.dispose();
  });
});
