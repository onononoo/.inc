/**
 * The single typed IPC surface between the renderer and the main process.
 *
 * Each domain declares its own `*Invoke` (request/response) and `*Events` (main -> renderer
 * push) interfaces in `./api/*`. This file merges them; do not add channels here.
 *
 * Wire rules:
 *  - Channel names are `domain:action`.
 *  - Handlers may be sync or async and simply `throw`; errors travel as `SerializedError` and are
 *    re-thrown in the renderer as `IncError`.
 *  - Payloads must be structured-cloneable (no functions, class instances, Maps/Sets are fine).
 */
import type { AppEvents, AppInvoke } from './api/app';
import type { DialogEvents, DialogInvoke } from './api/dialog';
import type { FsEvents, FsInvoke } from './api/fs';
import type { GitEvents, GitInvoke } from './api/git';
import type { SearchEvents, SearchInvoke } from './api/search';
import type { SettingsEvents, SettingsInvoke } from './api/settings';
import type { TerminalEvents, TerminalInvoke } from './api/terminal';
import type { WindowEvents, WindowInvoke } from './api/window';
import type { WorkspaceEvents, WorkspaceInvoke } from './api/workspace';
import type { SerializedError } from './errors';

export type InvokeMap = AppInvoke &
  WindowInvoke &
  DialogInvoke &
  WorkspaceInvoke &
  FsInvoke &
  SearchInvoke &
  GitInvoke &
  TerminalInvoke &
  SettingsInvoke;

/** Event payload map. A `void` payload means the event carries no data. */
export type EventMap = AppEvents &
  WindowEvents &
  DialogEvents &
  WorkspaceEvents &
  FsEvents &
  SearchEvents &
  GitEvents &
  TerminalEvents &
  SettingsEvents;

export type InvokeChannel = keyof InvokeMap;
export type EventChannel = keyof EventMap;

export type InvokeArgs<K extends InvokeChannel> = Parameters<InvokeMap[K]>;
export type InvokeResult<K extends InvokeChannel> = Awaited<ReturnType<InvokeMap[K]>>;

/** Envelope used on the wire so errors keep their code. */
export type IpcEnvelope<T = unknown> =
  { ok: true; value: T } | { ok: false; error: SerializedError };

/** Origin that hosts the renderer; the main process rejects IPC from any other frame. */
export const APP_SCHEME = 'inc';
export const APP_ORIGIN = 'inc://app';
