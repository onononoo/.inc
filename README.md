# .inc

An open-source desktop code editor for engineering organizations that work in very large repositories. It looks and behaves like the editors developers already know, with a quiet interface, no telemetry, no network access and controls for administrators.

- **Editor.** Monaco, with tabs, split view, breadcrumbs, a diff view, EditorConfig, encoding and line-ending handling, and safe handling of very large files.
- **Explorer, quick open and search.** Lazy file tree, a fuzzy file index, and search and replace in files that streams results from worker threads.
- **Source control.** Status, stage, commit, branches, history and diffs through the installed `git`.
- **Terminal.** A real shell in a pseudo-terminal, disabled in Restricted Mode.
- **Settings.** A settings editor, a shortcuts editor, four themes (light, dark and two high-contrast), and layered configuration.
- **Safe by default.** Sandboxed renderer, strict content security policy, workspace trust (Restricted Mode), and every network request blocked and counted. There is no telemetry.
- **Managed.** An administrator policy file can lock settings and switch off the terminal, tasks, Git remote operations and external links. See [docs/ADMIN.md](docs/ADMIN.md).

## Run from source

Requirements: Node.js 22 or newer and Git. See [CONTRIBUTING.md](CONTRIBUTING.md) for platform notes.

```bash
npm ci
npm run dev
```

## Build a distributable

```bash
npm run package
```

This builds, packages for the current platform, checks the layout and launches the result as a smoke test. See [docs/PACKAGING.md](docs/PACKAGING.md).

## Check your changes

```bash
npm run verify        # typecheck, lint, unit tests, hygiene check
npm run test:e2e      # Playwright against the real Electron app
```

## Documentation

| Document                                     | Contents                                                       |
| -------------------------------------------- | -------------------------------------------------------------- |
| [docs/ADMIN.md](docs/ADMIN.md)               | Deploying the policy file, what it can enforce, security model |
| [docs/SETTINGS.md](docs/SETTINGS.md)         | Every setting, generated from the schema                       |
| [docs/KEYBINDINGS.md](docs/KEYBINDINGS.md)   | Every default shortcut, generated from the command catalog     |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Processes, slices, the typed IPC contract                      |
| [docs/DESIGN.md](docs/DESIGN.md)             | Design tokens, themes, component rules                         |
| [docs/PACKAGING.md](docs/PACKAGING.md)       | Packaging and the packaged-app smoke test                      |
| [docs/RELEASING.md](docs/RELEASING.md)       | Versioning, tagging and the release workflow                   |
| [SECURITY.md](SECURITY.md)                   | Reporting vulnerabilities                                      |

## License

MIT. Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and under **Help > Third-party notices**.
