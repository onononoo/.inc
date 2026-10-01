/** Starter content for files created by "Open settings (JSON)" and friends. */

export const USER_SETTINGS_TEMPLATE = `// User settings for .inc. Comments and trailing commas are allowed.
// Changes apply as soon as this file is saved.
{
}
`;

export const WORKSPACE_SETTINGS_TEMPLATE = `// Workspace settings for .inc. They apply to everyone who opens this folder and
// override the user's own settings. Commit this file to share it with your team.
{
}
`;

export const KEYBINDINGS_TEMPLATE = `// Custom keyboard shortcuts for .inc. Comments and trailing commas are allowed.
// Changes apply as soon as this file is saved.
//
// Add a shortcut:
//   { "key": "Mod+Alt+L", "command": "edit.formatDocument", "when": "editorFocus" },
// Remove a default shortcut by putting a minus sign in front of the command:
//   { "key": "Mod+P", "command": "-palette.quickOpen" },
[
]
`;
