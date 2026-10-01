import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { IncBridge } from '@shared/bridge';
import type { IpcEnvelope } from '@shared/ipc';
import type { Platform } from '@shared/paths';

const CHANNEL = /^[a-z]+:[A-Za-z]+$/;

function assertChannel(channel: string): void {
  if (!CHANNEL.test(channel)) throw new Error(`Invalid channel: ${channel}`);
}

const bridge: IncBridge = {
  platform: process.platform as Platform,

  invokeRaw(channel, ...args) {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, ...args) as Promise<IpcEnvelope<never>>;
  },

  on(channel, listener) {
    assertChannel(channel);
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload as never);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('inc', bridge);
