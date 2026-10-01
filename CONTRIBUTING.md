# Contributing to .inc

Thank you for helping. .inc is a code editor for engineers at very large organisations, so the bar is calm, precise, fast, accessible and safe. This guide covers how to set up, where code lives, how to test and how changes are reviewed. By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, following [SECURITY.md](SECURITY.md).

## Set up

Requirements: Node.js 22 or newer (CI uses 24), npm 10 or newer, and Git. No C++ toolchain is needed on Windows or macOS because `node-pty` and `@parcel/watcher` ship prebuilt binaries there. On Linux, `node-pty` is compiled during `npm ci`, which needs `python3`, `make` and a C++ compiler.

```
npm ci
npm run dev
```

`npm run dev` builds into `.tmp/dev`, starts Electron, restarts it when the main process or preload change and reloads the window when the renderer changes. It uses its own user-data directory (`.tmp/dev-user-data`) so it never touches the settings of an installed copy. Pass a folder to open after `--`: `npm run dev -- -- path/to/folder`.

## Layout of `src/`

```
src/
  shared/      Platform-neutral types and logic used by both processes: the typed IPC contract
               (ipc.ts, api/*.ts), settings schema, policy model, command catalog, errors.
               No Node, Electron or React imports.
  main/        The Node side. One folder per slice with an index.ts that exports register(kernel).
  preload/     The single contextBridge surface (window.inc).
  renderer/    The sandboxed React UI. One folder per slice with a register.ts.
               services/ (IPC client, service locator), state/, contracts/, styles/tokens.css, ui/.
scripts/       Build, dev runner, packaging, license inventory, icon generation, hygiene check.
tests/
  unit/<slice>/   Vitest, Node environment.
  e2e/            Playwright driving the real Electron app.
docs/          Architecture, design system, packaging and releasing.
resources/     Brand source (resources/brand) and generated icons (resources/icons).
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first and [docs/DESIGN.md](docs/DESIGN.md) before touching UI.

## Slice conventions

- **Contract first.** A capability that crosses the process boundary is declared in `src/shared/api/<domain>.ts` and aggregated in `src/shared/ipc.ts`. Extend contracts additively: new optional fields, new channels, new commands. Do not rename or remove existing channels, command ids or types.
- **Slices do not import each other.** In main, slices cooperate through the kernel (`settings`, `policy`, `workspaces`, `fsChanges`, `handle`, `send`, `broadcast`) and read it lazily at call time. In the renderer, slices cooperate through the service locator (`service('editor')`) and the command bus (`service('commands').execute('editor.openFile', { path })`).
- **The renderer has no Node.** It reaches main only through `src/renderer/services/ipc.ts`.
- **Validate at the boundary.** Main validates every IPC argument (absolute paths, types, ranges). Never build shell command strings: use `execFile` or `spawn` with argument arrays.
- **No network, no telemetry.** Nothing in the product opens a network connection or sends data off the device.
- **Untrusted workspaces run no code.** Terminal, tasks and repository-driven Git behaviour are off in Restricted Mode.
- **Performance.** Assume a repository with a million files and files of 100 MB. Nothing may scan a whole tree on the UI path; stream, batch, debounce, cap and virtualise.
- **Errors.** Throw `IncError` with a specific code in main; show recoverable errors with `describeError` and a next step; log through `kernel.logger`; never swallow errors.
- **Styling and accessibility.** Use CSS custom properties from `tokens.css`, never hard-coded colours. Icons are lucide-react at 16 px with a 1.5 px stroke. Sentence-case copy, no emoji. Every interactive element is keyboard accessible with a visible focus ring and correct ARIA roles and labels (WCAG 2.2 AA). Respect `prefers-reduced-motion`.
- **No placeholder code.** No TODO comments, dead code or half-implemented features.

## Run the checks

```
npm run typecheck        # main + preload + shared, renderer + shared, tests
npm run lint             # eslint
npm run format:check     # prettier (npm run format fixes it)
npm test                 # Vitest unit tests (npx vitest run tests/unit/<slice> for one slice)
npm run check:hygiene    # forbidden terms, Node imports in the renderer, secret-like files
npm run licenses -- --check   # third-party license inventory is allowed and up to date
```

End-to-end tests drive the real application. Build to an isolated directory so parallel work does not collide:

```
node scripts/build.mjs --out .tmp/myslice
INC_APP_DIR=.tmp/myslice npx playwright test tests/e2e/myslice.spec.ts
```

Every launch gets its own temporary user-data directory and a hidden window; set `INC_TEST_SHOW=1` to watch. `tests/e2e/harness.ts` and `tests/e2e/fixtures.ts` give you a realistic workspace with Git history. For anything visual, take screenshots into `test-results/screens/<slice>-*.png` and look at them against the design system.

Write tests for real behaviour, including failure paths, and run real code (temporary directories, real Git) rather than mocks where you can.

To produce and smoke-test a packaged build, see [docs/PACKAGING.md](docs/PACKAGING.md).

## Commit style

- Imperative, present-tense subject of at most 72 characters, no trailing period: `Add quick-open ranking for camelCase queries`.
- A body that explains why, wrapped at 72 characters, when the subject is not enough.
- One logical change per commit. Reference issues as `Fixes #123` in the body.
- Do not commit generated output (`dist/`, `release/`, `.tmp/`, `test-results/`). `THIRD_PARTY_NOTICES.md` and the icons under `resources/icons/` are generated but committed: regenerate them with `npm run licenses` and `node scripts/make-icons.mjs` when their inputs change.

## Developer Certificate of Origin

Every commit must be signed off to certify that you wrote it or have the right to submit it under the project license, as described by the [Developer Certificate of Origin 1.1](https://developercertificate.org/). Add the sign-off with `git commit -s`, which appends:

```
Signed-off-by: Your Name <you@example.com>
```

The name and address must match the commit author. Pull requests with unsigned commits are not merged.

## Pull requests and review

1. Open an issue first for anything larger than a small fix, so the design can be agreed before code is written.
2. Keep pull requests focused and small enough to review in one sitting. Fill in the pull request template.
3. CI must be green on Windows, macOS and Linux: typecheck, lint, formatting, unit tests, build, end-to-end tests, hygiene and license checks.
4. Include tests for new behaviour and for the failure paths. Update documentation and `CHANGELOG.md` (under Unreleased) for user-visible changes.
5. UI changes need screenshots in light and dark themes and a note on keyboard and screen-reader behaviour.
6. At least one maintainer listed in `.github/CODEOWNERS` for the touched area must approve. Reviewers look for correctness, security (trust boundaries, argument validation), performance on huge repositories, accessibility, and fit with the architecture. Expect feedback within a few business days; ping the thread if it stalls.
7. Maintainers squash or rebase merge; the sign-off line is kept.

## Adding or updating dependencies

New runtime or build dependencies need a maintainer's agreement in the issue first. Run `npm run licenses` after any change: it fails on a missing, unknown or copyleft license (GPL, AGPL, SSPL and similar are not compatible with MIT distribution) and rewrites `THIRD_PARTY_NOTICES.md`, which must be committed with the change.

## Licensing of contributions

By contributing you agree that your work is licensed under the [MIT License](LICENSE).
