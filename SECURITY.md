# Security policy

## Supported versions

Security fixes are made on the latest minor release and on the `main` branch. Older minor releases are not patched; upgrade to the latest release.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Earlier | No |

## Reporting a vulnerability

Do not open a public issue for a security problem.

Send a report to **security@example.com**. This is a placeholder address: the maintainers must replace it, here and in `CODE_OF_CONDUCT.md`, with a monitored mailbox before the project is published. If the repository host offers private vulnerability reporting, enable it and list it here as the preferred channel.

Please include:

- the affected version and operating system;
- a description of the problem and its impact;
- steps to reproduce, or a proof of concept;
- whether you want to be credited, and under what name.

What to expect:

1. An acknowledgement within 3 business days.
2. An assessment and a severity rating within 10 business days.
3. A fix or a mitigation plan, agreed with you, before any public disclosure. We ask for a coordinated disclosure window of 90 days, and will shorten it when a fix ships sooner.
4. A published advisory and a note in `CHANGELOG.md` when the fix is released.

## Threat model summary

.inc is a desktop application that opens untrusted source trees on behalf of engineers. The design assumes that a repository can be hostile and that the renderer can be compromised by the content it displays.

- **Sandboxed renderer.** The renderer runs with `sandbox` and `contextIsolation` on and without Node integration. It is served from a privileged `inc://app` scheme under a strict Content Security Policy (no remote origins, no `eval`, no inline scripts). Navigation, `window.open` and `webview` are denied.
- **Narrow, validated IPC.** The renderer reaches the main process only through one typed bridge. Main validates every argument (absolute paths, types, ranges), rejects calls from frames outside the app origin, and never builds shell command strings: child processes are started with argument arrays.
- **No network, no telemetry.** All `http`, `https`, `ws`, `wss` and `ftp` requests from web content are cancelled and counted, and permission requests are denied. There is no telemetry, no crash reporting and no update check. Nothing leaves the device unless an engineer runs a command that does so, for example `git push` in the terminal.
- **Workspace trust.** A folder that has not been trusted opens in Restricted Mode: no terminal, no tasks, restricted settings from the workspace are ignored, and Git runs only hardened read operations that ignore repository-supplied configuration.
- **Administrator policy.** An administrator-deployed policy file can lock settings and switch features off. A malformed policy fails safe.
- **Supply chain.** The only production dependencies that stay outside the bundle are two native modules (`node-pty` and `@parcel/watcher`); everything else is bundled at build time. `npm run licenses` fails for unknown or copyleft licenses, and every release ships a CycloneDX SBOM and SHA-256 checksums.

Out of scope: problems that need an already-compromised operating system account, social engineering of a user into running commands in the integrated terminal of a workspace they chose to trust, and issues in Electron or Chromium that are already fixed in a newer Electron release (report those upstream; the project upgrades Electron promptly).

## Hardening for administrators

Releases are packaged as described in `docs/PACKAGING.md`. Sign and notarize them with your organisation's certificates before distribution, and verify the published SHA-256 checksums before deploying.
