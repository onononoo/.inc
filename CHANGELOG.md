# Changelog

All notable changes to .inc are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

First public version. The release date is set when the version is tagged.

### Added

- Desktop code editor built on Electron, React, TypeScript and Monaco, with a sandboxed renderer and a typed IPC contract between the main and renderer processes.
- Explorer, quick open, search and replace in files, Git source control, an integrated terminal and a settings editor, designed for very large repositories (lazy trees, virtualised lists, worker-thread search, native file watching).
- Workspace trust with Restricted Mode, layered settings (defaults, user, workspace, administrator policy) and an administrator policy file that can lock settings and switch features off.
- Four colour themes built on one design token system, with keyboard access and visible focus throughout, targeting WCAG 2.2 AA.
- No telemetry and no network access: all `http`, `https`, `ws`, `wss` and `ftp` requests from web content are blocked.
- Release engineering: a watch-mode development runner, a production packaging script with a smoke test of the packaged app, a third-party license inventory that generates `THIRD_PARTY_NOTICES.md`, an icon generator, continuous integration on Windows, macOS and Linux, and a tag-triggered release workflow that publishes archives, SHA-256 checksums and a CycloneDX SBOM.
