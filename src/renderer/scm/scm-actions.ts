import type { GitBranch } from '@shared/api/git';
import type { DiffInput } from '../contracts/editor';
import { describeError, isIncError } from '@shared/errors';
import { basename } from '@shared/paths';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { useGitStore, refreshGit } from './git-store';
import { validateBranchName } from './scm-model';

const notifications = () => service('notifications');

/** Report a failed Git call in plain language, with a way forward for the two managed cases. */
function report(title: string, error: unknown): void {
  if (isIncError(error, 'E_POLICY')) {
    notifications().warn(title, 'Managed by your organization. This action is turned off.');
  } else if (isIncError(error, 'E_UNTRUSTED')) {
    notifications().notify({
      level: 'warning',
      message: title,
      detail: 'This folder is in Restricted Mode. Trust it to change the repository.',
      actions: [{ label: 'Trust folder', run: () => void ipc.invoke('workspace:setTrust', true) }],
    });
  } else {
    notifications().error(title, describeError(error));
  }
}

async function attempt(title: string, work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return true;
  } catch (error) {
    report(title, error);
    return false;
  }
}

export const stage = (paths: string[]) =>
  attempt('Could not stage the changes.', () => ipc.invoke('git:stage', paths));
export const unstage = (paths: string[]) =>
  attempt('Could not unstage the changes.', () => ipc.invoke('git:unstage', paths));
export const stageAll = () =>
  attempt('Could not stage the changes.', () => ipc.invoke('git:stageAll'));
export const unstageAll = () =>
  attempt('Could not unstage the changes.', () => ipc.invoke('git:unstageAll'));

/** Discard changes after a confirmation that says exactly what will be lost. */
export async function discard(paths: string[], untracked: number): Promise<boolean> {
  if (paths.length === 0) return false;
  const single = paths.length === 1;
  const ok = await service('dialogs').confirm({
    title: single
      ? `Discard changes to ${basename(paths[0] as string)}?`
      : `Discard changes to ${paths.length} files?`,
    message: 'This cannot be undone.',
    detail:
      untracked > 0
        ? `${untracked === 1 ? 'An untracked file' : `${untracked} untracked files`} will be deleted.`
        : undefined,
    confirmLabel: 'Discard changes',
    danger: true,
  });
  if (!ok) return false;
  return attempt('Could not discard the changes.', () => ipc.invoke('git:discard', paths));
}

export async function commit(message: string, amend: boolean): Promise<boolean> {
  try {
    const { sha } = await ipc.invoke('git:commit', { message, amend });
    notifications().info(amend ? 'Commit amended.' : 'Changes committed.', sha.slice(0, 7));
    return true;
  } catch (error) {
    report(amend ? 'Could not amend the commit.' : 'Could not commit.', error);
    return false;
  }
}

export const fetchRemote = () => attempt('Could not fetch.', () => ipc.invoke('git:fetch'));
export const pull = () => attempt('Could not pull.', () => ipc.invoke('git:pull'));
export const push = () => attempt('Could not push.', () => ipc.invoke('git:push'));
export const refresh = () => refreshGit();

export async function initRepository(): Promise<boolean> {
  return attempt('Could not initialize the repository.', () => ipc.invoke('git:init'));
}

// --- branches -------------------------------------------------------------------------------

export async function createBranch(): Promise<void> {
  const name = await service('quickInput').input({
    title: 'Create branch',
    prompt: 'Enter a name for the new branch. It starts from the current commit.',
    placeholder: 'Branch name',
    validate: (value) => validateBranchName(value),
  });
  if (!name) return;
  await attempt('Could not create the branch.', () =>
    ipc.invoke('git:createBranch', name.trim(), true),
  );
}

export async function checkout(): Promise<void> {
  let branches: GitBranch[];
  try {
    branches = await ipc.invoke('git:branches');
  } catch (error) {
    report('Could not list the branches.', error);
    return;
  }
  const create = { id: '__create__', label: 'Create new branch...', icon: 'plus' };
  const local = branches
    .filter((b) => !b.remote)
    .map((b) => ({
      id: b.name,
      label: b.name,
      group: 'Branches',
      icon: 'git-branch',
      description: b.upstream ? `tracks ${b.upstream}` : undefined,
    }));
  const remote = branches
    .filter((b) => b.remote)
    .map((b) => ({ id: b.name, label: b.name, group: 'Remote branches', icon: 'cloud' }));
  const current = branches.find((b) => b.current)?.name;
  const picked = await service('quickInput').pick([create, ...local, ...remote], {
    placeholder: 'Select a branch to check out',
    title: 'Checkout to',
    activeIds: current ? [current] : [],
  });
  if (!picked) return;
  if (picked.id === '__create__') {
    await createBranch();
    return;
  }
  await attempt(`Could not check out ${picked.id}.`, () => ipc.invoke('git:checkout', picked.id));
}

// --- diffs ----------------------------------------------------------------------------------

/** Build the comparison for a file: HEAD against the working file, or HEAD against the index. */
export async function buildDiff(path: string, staged: boolean): Promise<DiffInput | null> {
  const name = basename(path);
  try {
    const head = await ipc.invoke('git:show', path, 'HEAD');
    if (head.binary) {
      notifications().info('Binary files cannot be compared.', name);
      return null;
    }
    if (head.tooLarge) {
      notifications().info('This file is too large to compare.', name);
      return null;
    }
    const original = {
      originalLabel: head.exists ? 'HEAD' : 'Empty',
      originalText: head.exists ? head.content : '',
    };
    if (staged) {
      const index = await ipc.invoke('git:show', path, 'INDEX');
      if (index.binary || index.tooLarge) {
        notifications().info('This file cannot be compared as text.', name);
        return null;
      }
      return {
        path,
        ...original,
        modified: { kind: 'text', label: 'Index', text: index.exists ? index.content : '' },
        title: `${name} (Index)`,
      };
    }
    const status = useGitStore.getState().status;
    const entry = status?.files.find((f) => f.path === path);
    if (entry?.workingTree === 'D') {
      return {
        path,
        ...original,
        modified: { kind: 'text', label: 'Deleted', text: '' },
        title: `${name} (Working Tree)`,
      };
    }
    return { path, ...original, modified: { kind: 'file' }, title: `${name} (Working Tree)` };
  } catch (error) {
    report(`Could not compare ${name}.`, error);
    return null;
  }
}

export async function openDiff(path: string, staged: boolean): Promise<void> {
  const diff = await buildDiff(path, staged);
  if (diff) await service('editor').openDiff(diff);
}
