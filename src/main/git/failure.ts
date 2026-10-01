import { IncError } from '@shared/errors';

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const MAX_MESSAGE_LINES = 6;
const MAX_MESSAGE_CHARS = 900;

/** Remove `user:password@` from URLs so credentials never reach the UI or the log. */
export function redactCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, '$1');
}

export interface GitOutput {
  stdout: string;
  stderr: string;
}

function filesAfter(text: string, marker: RegExp): string[] {
  const match = marker.exec(text);
  if (!match) return [];
  const rest = text.slice(match.index + match[0].length).split(/\r?\n/);
  const files: string[] = [];
  for (const line of rest) {
    if (!/^[\t ]+\S/.test(line)) break;
    files.push(line.trim());
  }
  return files;
}

function listFiles(files: string[]): string {
  if (files.length === 0) return 'some files';
  const shown = files.slice(0, 4).join(', ');
  return files.length > 4 ? `${shown} and ${files.length - 4} more` : shown;
}

/** Strip Git's severity prefixes and hints, and keep a short, safe excerpt. */
function excerpt(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^(fatal|error|warning):\s*/i, '').trim())
    .filter((line) => line !== '' && !/^hint:/i.test(line));
  const joined = lines.slice(0, MAX_MESSAGE_LINES).join(' ');
  return joined.length > MAX_MESSAGE_CHARS ? joined.slice(0, MAX_MESSAGE_CHARS) + '...' : joined;
}

/**
 * Turn the output of a failed Git command into a plain sentence with a next step. Known failures
 * get a tailored message; anything else falls back to Git's own text, with credentials removed.
 */
export function explainGitFailure(output: GitOutput): string {
  const stderr = redactCredentials(output.stderr);
  const stdout = redactCredentials(output.stdout);
  const all = `${stderr}\n${stdout}`;

  if (/detected dubious ownership|unsafe repository/i.test(all)) {
    const folder = /safe\.directory\s+'?([^'\r\n]+)'?/i.exec(all)?.[1]?.trim();
    return (
      'Git does not trust the owner of this repository. ' +
      (folder
        ? `Run "git config --global --add safe.directory ${folder}" in a terminal, then try again.`
        : 'Add the folder to safe.directory in your Git configuration, then try again.')
    );
  }
  if (/not a git repository/i.test(all)) return 'This folder is not a Git repository.';
  if (/Unable to create '[^']*\.lock'|\.lock': File exists|another git process/i.test(all)) {
    return (
      'Another Git process is using this repository. Wait for it to finish and try again. ' +
      'If none is running, delete the .lock file inside the .git folder.'
    );
  }
  if (/Please tell me who you are|Author identity unknown|unable to auto-detect email/i.test(all)) {
    return 'Git does not know who you are. Set user.name and user.email in your Git configuration, then commit again.';
  }
  if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(all)) {
    return 'There are no staged changes to commit. Stage changes first.';
  }
  if (/would be overwritten by (checkout|merge)/i.test(all) && /local changes/i.test(all)) {
    const files = filesAfter(all, /would be overwritten by (?:checkout|merge):?\r?\n/i);
    return `Your local changes to ${listFiles(files)} would be overwritten. Commit or discard them, then try again.`;
  }
  if (/untracked working tree files would be overwritten/i.test(all)) {
    const files = filesAfter(all, /would be overwritten by (?:checkout|merge):?\r?\n/i);
    return `Untracked files (${listFiles(files)}) would be overwritten. Move or delete them, then try again.`;
  }
  if (
    /you need to resolve your current index first|needs merge|unmerged files|unresolved conflict/i.test(
      all,
    )
  ) {
    return 'Resolve the merge conflicts and stage the resolved files first.';
  }
  if (/The following paths are ignored|are ignored by one of your \.gitignore/i.test(all)) {
    return 'Some of these paths are ignored by .gitignore and cannot be staged.';
  }
  if (/has no upstream branch|no upstream configured|--set-upstream/i.test(all)) {
    return 'This branch has no upstream branch yet. Publish it from a terminal with "git push --set-upstream <remote> <branch>".';
  }
  if (/divergent branches|Not possible to fast-forward/i.test(all)) {
    return 'Your branch and its upstream have diverged. Run "git pull" in a terminal to choose merge or rebase, or set pull.rebase in your Git configuration.';
  }
  if (/non-fast-forward|\[rejected\]|failed to push some refs|fetch first/i.test(all)) {
    return 'The remote has changes you do not have. Pull them first, then push again.';
  }
  if (
    /Authentication failed|could not read Username|could not read Password|terminal prompts disabled|Permission denied \(publickey|Host key verification failed|HTTP Basic: Access denied/i.test(
      all,
    )
  ) {
    return 'Git could not sign in to the remote. Check your credentials or SSH key, then try again.';
  }
  if (
    /Could not resolve host|Connection (timed out|refused|reset)|Network is unreachable|unable to access|Could not read from remote repository/i.test(
      all,
    )
  ) {
    return 'Git could not reach the remote. Check your network connection and the remote address, then try again.';
  }
  if (
    /No configured push destination|No remote repository specified|does not appear to be a git repository|No such remote/i.test(
      all,
    )
  ) {
    return 'This repository has no remote to use. Add one with "git remote add" in a terminal.';
  }
  if (
    /invalid reference|did not match any (file|branch)|unknown revision|not a valid object name|not a commit|Needed a single revision|bad revision/i.test(
      all,
    )
  ) {
    return 'That branch, tag or commit was not found in this repository.';
  }
  if (/already exists/i.test(all) && /branch/i.test(all)) {
    return 'A branch with that name already exists.';
  }
  if (/not a valid branch name|is not a valid ref|invalid branch name/i.test(all)) {
    return 'That is not a valid branch name.';
  }
  if (/hook .* (declined|exited with error)|hook failed|pre-commit|commit-msg/i.test(all)) {
    const detail = excerpt(stderr || stdout);
    return `A Git hook rejected the commit. ${detail}`.trim();
  }

  const detail = excerpt(stderr) || excerpt(stdout);
  return detail || 'Git reported an error without a message.';
}

/** Build the E_GIT error for a failed command. */
export function gitFailure(
  output: GitOutput & { code: number },
  details?: Record<string, unknown>,
): IncError {
  return new IncError('E_GIT', explainGitFailure(output), {
    exitCode: output.code,
    stderr: redactCredentials(output.stderr).slice(0, 2000),
    ...details,
  });
}
