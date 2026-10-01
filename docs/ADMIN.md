# Administrator guide

.inc reads one JSON policy file from a machine-wide location that only administrators can write. Everything in it is enforced: policy values override user and workspace settings, appear locked in the settings editor, and the `features` section switches whole capabilities off. Help > About and **Managed configuration** show the file that was read and the notice you set.

## Location

| Platform | Path                                            |
| -------- | ----------------------------------------------- |
| Windows  | `%ProgramData%\.inc\policy.json`                |
| macOS    | `/Library/Application Support/.inc/policy.json` |
| Linux    | `/etc/inc/policy.json`                          |

Deploy it with MDM, Group Policy or configuration management, and make the file writable only by administrators. Packaged builds ignore the `INC_POLICY_FILE` environment variable, because users control their own environment. Development builds honour it, for testing.

## Format

```json
{
  "version": 1,
  "notice": "Managed by Acme IT. Contact help@acme.example.",
  "settings": {
    "security.workspaceTrust": true
  },
  "features": {
    "terminal": false,
    "tasks": false,
    "gitRemoteOperations": true,
    "externalLinks": "deny"
  }
}
```

- `version` must be `1`.
- `settings` accepts any key listed in [SETTINGS.md](SETTINGS.md). A value that fails validation is ignored and reported as a warning in **Managed configuration**; the rest of the file still applies.
- `notice` is plain text of at most 500 characters. Markup and control characters are removed.

### Features

| Feature               | Values                    | Effect                                                                          |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------- |
| `terminal`            | `true`, `false`           | `false` turns off the integrated terminal.                                      |
| `tasks`               | `true`, `false`           | `false` turns off running tasks.                                                |
| `gitRemoteOperations` | `true`, `false`           | `false` blocks fetch, pull and push. Local Git keeps working.                   |
| `externalLinks`       | `allow`, `prompt`, `deny` | How links that open in the system browser are handled. The default is `prompt`. |

## Workspace trust

A folder opens in Restricted Mode until the user trusts it (unless workspace trust is turned off, which policy can enforce). In Restricted Mode the terminal and tasks are off, workspace settings marked _restricted_ are ignored, and Git only reads the repository, with repository-defined commands disabled.

## Network and telemetry

.inc sends no telemetry. All `http`, `https`, `ws`, `wss` and `ftp` requests from the application's web content are blocked, and the count of blocked requests is included in the diagnostics report (**Help > Copy diagnostics**). The report contains versions, operating system, policy state and which settings come from which layer. It contains no file contents or user identity.

## Logs

**Help > Show logs folder** opens the log directory. Renderer logging is rate-limited.
