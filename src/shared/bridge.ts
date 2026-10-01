import type {
  EventChannel,
  EventMap,
  InvokeArgs,
  InvokeChannel,
  InvokeResult,
  IpcEnvelope,
} from './ipc';
import type { Platform } from './paths';

/**
 * The only object the preload script exposes to the renderer, as `window.inc`.
 * Everything else in the main process is unreachable from web content.
 *
 * `invokeRaw` returns the wire envelope because Electron's context bridge drops custom error
 * properties; use `ipc.invoke` from `renderer/services/ipc.ts`, which unwraps it and throws
 * `IncError` with the original code.
 */
export interface IncBridge {
  readonly platform: Platform;
  invokeRaw<K extends InvokeChannel>(
    channel: K,
    ...args: InvokeArgs<K>
  ): Promise<IpcEnvelope<InvokeResult<K>>>;
  /** Subscribe to a main-process event. Returns an unsubscribe function. */
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void;
}
