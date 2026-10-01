# Architecture

.inc is an Electron application: a small, locked-down main process that owns everything that touches the machine, and a sandboxed React renderer that owns everything the user sees. The two communicate through one typed contract.

```
┌──────────────────────────── renderer (sandboxed, no Node) ─────────────────────────────┐
│  workbench  commands  editor  explorer  search  scm  terminal  settings-ui             │
│        └────── service locator + command bus ──────┘                                    │
│                     src/renderer/services/ipc.ts  (window.inc)                         │
└──────────────────────────────────────┬─────────────────────────────────────────────────┘
                                       │  typed IPC  (src/shared/ipc.ts, src/shared/api/*)
┌──────────────────────────────────────┴─────────────────────────────────────────────────┐
│  preload (contextBridge: invokeRaw + on)                                                │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│  main process kernel: handle / send / broadcast, settings, policy, workspaces, fsChanges│
│  shell  settings  workspace  fs  search (workers)  git  terminal (pty)                  │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## Principles

1. **Contract first.** Every capability crossing the process boundary is declared in `src/shared/api/<domain>.ts` and aggregated in `src/shared/ipc.ts`. Handlers and callers are type-checked against the same declaration.
2. **Slices, not layers.** A feature owns its main-process service, its IPC surface, its commands and its UI. Slices never import each other's internals; they cooperate through the kernel (main) and the service locator and command bus (renderer).
3. **Safe by construction.** The renderer has no Node, no network, no ambient authority. Everything privileged is a narrow, validated IPC call.
4. **Fast on huge repositories.** No UI path scans a tree. Trees are lazy, lists are virtualised, searches stream from worker threads, Git status is throttled and capped, file watching is native.
5. **Administrable.** Policy, trust and settings are first-class and layered, so an organisation can standardise and lock behaviour without forking.

## Processes

### Main

`src/main/index.ts` boots the app: single-instance lock, the privileged `inc://` scheme, session lock-down, the kernel, the slices and the first window.

The **kernel** (`src/main/kernel.ts`) is the only thing slices share:

| Facility              | Purpose                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `handle(channel, fn)` | Register an IPC handler. Throwing rejects the renderer call with an `IncError`.            |
| `send`, `broadcast`   | Push typed events to one window or all.                                                    |
| `settings`            | Read effective settings for a window (defaults, user, workspace, policy).                  |
| `policy`              | Enterprise policy state and feature switches.                                              |
| `workspaces`          | Per-window root folder, trust state, last opened folder.                                   |
| `fsChanges`           | Debounced file system change batches, emitted by the fs slice for others (Git) to consume. |
| `onWindowClosed`      | Release per-window resources.                                                              |

Each slice exports `register(kernel)` from `src/main/<slice>/index.ts`; `src/main/register-all.ts` calls them in dependency order. Slices read `kernel.settings`, `kernel.policy` and `kernel.workspaces` at call time, never caching them, because the settings and workspace slices replace the default implementations.

| Slice       | Responsibility                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `shell`     | Application menu, window management, dialogs, safe-close handshake, launch arguments, external links, diagnostics, hardening. |
| `settings`  | Layered settings, JSONC editing that preserves comments, enterprise policy, keybindings file.                                 |
| `workspace` | Open and close folders, workspace trust, recent folders, per-workspace session blobs.                                         |
| `fs`        | File read and write with encoding detection, atomic saves, native watching, quick-open file index, EditorConfig.              |
| `search`    | Worker-thread text search and replace with ignore-file support.                                                               |
| `git`       | Git CLI integration: status, diff content, stage, commit, branches, remote operations.                                        |
| `terminal`  | Pseudo-terminal sessions, shell profiles, tasks.                                                                              |

### Preload

`src/preload/index.ts` exposes exactly one object, `window.inc`, with `invokeRaw` and `on`. `invokeRaw` returns a wire envelope (`{ ok, value } | { ok: false, error }`) because Electron's context bridge strips custom properties from thrown errors; `renderer/services/ipc.ts` unwraps it and rethrows an `IncError` with the original `code`.

### Renderer

The renderer is React with small zustand stores. Slices live in `src/renderer/<slice>/` and provide services and command handlers from a `register.ts` invoked by `src/renderer/register-all.ts`.

- **Service locator** (`services/registry.ts`): `service('editor')`, `service('dialogs')`, and so on. Interfaces live in `src/renderer/contracts/`.
- **Command bus**: `service('commands').execute('editor.openFile', { path })`. Command ids, titles, keybindings, menu placement and enablement live in the catalog in `src/shared/commands/`, which also drives the native menus and generated documentation.
- **Context keys and when clauses**: keybindings and commands are enabled with a small expression language (`src/shared/when.ts`), for example `explorerFocus && !inputFocus`.
- **Design system**: all styling uses CSS custom properties from `src/renderer/styles/tokens.css` (four themes). Monaco cannot read CSS variables, so `src/renderer/monaco/themes.ts` mirrors the same values. See [DESIGN.md](DESIGN.md).

## The IPC contract

- Channel names are `domain:action` and are validated in preload.
- Requests are `InvokeMap` entries (`Parameters` and `Awaited<ReturnType>` give the types); pushes are `EventMap` entries.
- Payloads must be structured-cloneable.
- Errors carry a stable `ErrorCode` (`E_NOT_FOUND`, `E_POLICY`, `E_UNTRUSTED`, ...). Renderer code branches on the code and shows `describeError(error)`.
- The main process rejects any IPC call whose sender frame is not served from the app origin.

## Security model

| Layer           | Control                                                                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer        | `sandbox`, `contextIsolation`, no `nodeIntegration`, no `webview`, navigation and `window.open` denied.                                                                                                          |
| Content         | Served from the privileged `inc://app` scheme with a strict CSP (no remote origins, no `eval`, no inline script). Path traversal outside the renderer root is refused.                                           |
| Network         | Every `http`, `https`, `ws`, `wss` and `ftp` request from web content is cancelled and counted; permission requests are denied. Diagnostics report the blocked count. There is no telemetry and no update check. |
| IPC             | Arguments validated in main; absolute paths required; no shell strings, only argument arrays.                                                                                                                    |
| Workspace trust | Untrusted folders open in Restricted Mode: no terminal, no tasks, restricted settings ignored, Git limited to hardened read operations.                                                                          |
| Policy          | An administrator file can lock settings and switch features off; a malformed policy fails safe. See [ADMIN.md](ADMIN.md).                                                                                        |

## Settings, policy and trust

Effective settings are resolved in this order, lowest to highest: **defaults, user `settings.json`, workspace `.inc/settings.json`, policy**. Object-valued settings merge key by key. Settings marked `restricted` in the schema (`src/shared/settings.ts`) are ignored when they come from an untrusted workspace. Files are JSONC and are edited in place so comments survive.

## Performance rules of thumb

- Directory listing is lazy and stat calls are bounded.
- The quick-open index is built once per workspace (from `git ls-files` when possible), updated incrementally by the watcher, and queried with a top-K selection rather than a full sort.
- Search runs in worker threads, streams batches, honours ignore files and caps results and line lengths.
- Git status runs with optional locks disabled, coalesces concurrent requests, caps the file list and backs off automatically when a repository is slow.
- Large files open with expensive editor features switched off; very large files are refused with an explanation.

## Testing

- **Unit** (`tests/unit/**`, Vitest): pure logic and real file system or Git work in temporary directories.
- **End to end** (`tests/e2e/**`, Playwright driving the real Electron app): each launch gets a temporary user-data directory and a hidden window. Build to an isolated directory with `node scripts/build.mjs --out .tmp/<name>` and run with `INC_APP_DIR=.tmp/<name>`.
- **Hygiene** (`npm run check:hygiene`): file names and contents, and no Node imports in the renderer.

## Build

`scripts/build.mjs` bundles main, preload, renderer and the Monaco and search workers with esbuild into a runnable app directory (`electron <dir>`). Native modules (`node-pty`, `@parcel/watcher`) stay external and load from `node_modules`. See [PACKAGING.md](PACKAGING.md) for distributable builds.
