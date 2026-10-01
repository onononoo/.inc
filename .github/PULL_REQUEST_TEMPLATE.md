## What and why

<!-- What does this change do, and why? Link the issue: Fixes #123 -->

## How it was verified

<!-- Tests added or run, screenshots for UI changes (light and dark), manual checks. -->

## Checklist

- [ ] Every commit has a `Signed-off-by` line (`git commit -s`)
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test` pass
- [ ] End-to-end tests pass for the affected area
- [ ] `npm run check:hygiene` passes
- [ ] Tests cover new behaviour and failure paths
- [ ] No network access and no telemetry added
- [ ] IPC arguments are validated in main; no shell command strings
- [ ] Untrusted workspaces still run no code
- [ ] Works on Windows, macOS and Linux (paths, shells, line endings)
- [ ] UI: keyboard accessible, visible focus, ARIA labels, respects reduced motion
- [ ] Documentation and `CHANGELOG.md` updated
- [ ] `npm run licenses` run if dependencies changed
