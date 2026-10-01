import { IncError } from '@shared/errors';
import type { EventChannel, EventMap, InvokeArgs, InvokeChannel, InvokeResult } from '@shared/ipc';

/**
 * Typed access to the main process.
 *
 *   const entries = await ipc.invoke('fs:readDir', path);
 *   const off = ipc.on('fs:changed', (changes) => ...);
 *
 * `invoke` rejects with `IncError` carrying the original `code`.
 */
export const ipc = {
  async invoke<K extends InvokeChannel>(
    channel: K,
    ...args: InvokeArgs<K>
  ): Promise<InvokeResult<K>> {
    const envelope = await window.inc.invokeRaw(channel, ...args);
    if (envelope.ok) return envelope.value;
    throw new IncError(envelope.error.code, envelope.error.message, envelope.error.details);
  },

  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void {
    return window.inc.on(channel, listener);
  },
};

export const platform = window.inc.platform;
export const isMac = platform === 'darwin';
export const isWindows = platform === 'win32';
