import { basename } from '@shared/paths';
import type { CommandArgs } from '@shared/commands/catalog';
import { monaco } from '../monaco';
import { ipc } from '../services/ipc';
import { service } from '../services/registry';
import { getSetting, useSettingsStore } from '../state/settings-store';
import { setAmend, focusMessage, useCommitStore } from './commit-store';
import { GUTTER_MAX_BYTES, gutterMarks } from './gutter';
import { decorationFor, startGitSync, useGitStore } from './git-store';
import {
  checkout,
  commit,
  createBranch,
  fetchRemote,
  initRepository,
  openDiff,
  pull,
  push,
  refresh,
  stageAll,
  unstageAll,
} from './scm-actions';
import { clearCommit, setBusy } from './commit-store';
import { copyText } from '../ui/clipboard';

const DEBOUNCE_MS = 250;

/** A colour token as a value Monaco's overview ruler understands. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#808080';
}

/** Change markers in the editor's left margin, comparing the document with its committed text. */
function installGutter(): void {
  const headCache = new Map<string, { version: number; text: string | null }>();

  const headText = async (path: string): Promise<string | null> => {
    const version = useGitStore.getState().version;
    const cached = headCache.get(path);
    if (cached && cached.version === version) return cached.text;
    const text = await ipc.invoke('git:show', path, 'HEAD').then(
      (blob) => (blob.binary || blob.tooLarge ? null : blob.exists ? blob.content : ''),
      () => null,
    );
    headCache.set(path, { version, text });
    if (headCache.size > 200) headCache.delete(headCache.keys().next().value as string);
    return text;
  };

  service('editorHost').onEditor((editor, path) => {
    if (!path) return;
    const collection = editor.createDecorationsCollection([]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;

    const update = async () => {
      const model = editor.getModel();
      const status = useGitStore.getState().status;
      if (
        !alive ||
        !model ||
        !status ||
        !getSetting('git.gutterIndicators') ||
        model.getValueLength() > GUTTER_MAX_BYTES
      ) {
        collection.clear();
        return;
      }
      const untracked = decorationFor(path)?.tone === 'untracked';
      const original = untracked ? '' : await headText(path);
      if (!alive || original === null || editor.getModel() !== model) {
        if (alive && original === null) collection.clear();
        return;
      }
      const colors = {
        added: token('--git-added'),
        modified: token('--git-modified'),
        deleted: token('--git-deleted'),
      };
      collection.set(
        gutterMarks(original, model.getValue()).map((mark) => ({
          range: new monaco.Range(
            mark.startLine,
            1,
            Math.min(mark.endLine, model.getLineCount()),
            1,
          ),
          options: {
            isWholeLine: true,
            linesDecorationsClassName: `git-gutter-${mark.kind}`,
            overviewRuler: {
              color: colors[mark.kind],
              position: monaco.editor.OverviewRulerLane.Left,
            },
          },
        })),
      );
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void update(), DEBOUNCE_MS);
    };

    const content = editor.onDidChangeModelContent(schedule);
    const offStore = useGitStore.subscribe(schedule);
    const offSettings = useSettingsStore.subscribe(schedule);
    window.addEventListener('inc:theme-changed', schedule);
    schedule();
    return () => {
      alive = false;
      clearTimeout(timer);
      content.dispose();
      offStore();
      offSettings();
      window.removeEventListener('inc:theme-changed', schedule);
      collection.clear();
    };
  });
}

/** Provides the Git commands, the branch status item and the editor change gutter. */
export function register(): void {
  const commands = service('commands');
  const contextKeys = service('contextKeys');
  const run = (id: string, handler: (args?: never) => unknown) => commands.register(id, handler);

  startGitSync();
  installGutter();

  // The branch, in the status bar.
  const branch = service('statusBar').register({
    id: 'branch',
    side: 'left',
    priority: 900,
    icon: 'git-branch',
    text: '',
    command: 'git.checkout',
    tooltip: 'Checkout to branch',
    visible: false,
  });
  const syncBranch = () => {
    const status = useGitStore.getState().status;
    if (!status) {
      branch.update({ visible: false });
      return;
    }
    const { repo } = status;
    const sync = `${repo.behind > 0 ? ` ↓${repo.behind}` : ''}${repo.ahead > 0 ? ` ↑${repo.ahead}` : ''}`;
    branch.update({
      visible: true,
      text: `${repo.detached ? repo.head : (repo.branch ?? 'No commits')}${sync}`,
      tooltip: repo.upstream
        ? `Checkout to branch. Tracking ${repo.upstream}.`
        : 'Checkout to branch',
    });
  };
  useGitStore.subscribe(syncBranch);
  syncBranch();

  // Keyboard focus inside the view enables its shortcuts.
  const syncFocus = () =>
    contextKeys.set('scmFocus', !!document.activeElement?.closest('[data-testid="scm-view"]'));
  document.addEventListener('focusin', syncFocus, true);
  document.addEventListener('focusout', () => queueMicrotask(syncFocus), true);

  run('git.refresh', () => refresh());
  run('git.init', () => initRepository());
  run('git.stageAll', () => stageAll());
  run('git.unstageAll', () => unstageAll());
  run('git.checkout', () => checkout());
  run('git.createBranch', () => createBranch());
  run('git.fetch', () => fetchRemote());
  run('git.pull', () => pull());
  run('git.push', () => push());
  run('git.openDiff', ((args?: CommandArgs['git.openDiff']) =>
    args?.path ? openDiff(args.path, args.staged === true) : undefined) as never);

  const showCommitBox = () => {
    service('layout').showSidebar('git', { focus: false });
    focusMessage();
  };
  run('git.commit', async () => {
    const { message, amend } = useCommitStore.getState();
    if (!message.trim() && !amend) {
      showCommitBox();
      return;
    }
    setBusy(true);
    const ok = await commit(message, amend);
    setBusy(false);
    if (ok) clearCommit();
  });
  run('git.commitAmend', () => {
    setAmend(true);
    showCommitBox();
  });

  run('editor.openChanges', () => {
    const path = service('editor').getActivePath();
    if (!path) return undefined;
    const staged = useGitStore.getState().status?.files.find((f) => f.path === path);
    return openDiff(path, !!staged && staged.index !== null && staged.workingTree === null);
  });

  run('git.showFileHistory', async () => {
    const path = service('editor').getActivePath();
    if (!path) return;
    const log = await ipc.invoke('git:log', { path, limit: 50 });
    if (log.length === 0) {
      service('notifications').info('This file has no history yet.', basename(path));
      return;
    }
    const picked = await service('quickInput').pick(
      log.map((c) => ({
        id: c.sha,
        label: c.subject || '(no message)',
        description: `${c.shortSha}  ${c.author}  ${new Date(c.date).toLocaleDateString()}`,
        icon: 'git-commit',
      })),
      { placeholder: 'Select a commit to copy its id', title: `History of ${basename(path)}` },
    );
    if (picked && (await copyText(picked.id)))
      service('notifications').info('Commit id copied.', picked.id.slice(0, 7));
  });
}
