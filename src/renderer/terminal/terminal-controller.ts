import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import { create } from 'zustand';
import type { TaskDefinition, TerminalProfile } from '@shared/api/terminal';
import { describeError, isIncError } from '@shared/errors';
import { ipc, isWindows } from '../services/ipc';
import { service } from '../services/registry';
import { getSetting } from '../state/settings-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { copyText } from '../ui/clipboard';
import { findPathLinks, resolveLinkPath } from './links';
import '@xterm/xterm/css/xterm.css';

/** Characters processed before the renderer tells the main process it may send more. */
const ACK_BATCH = 5000;
const PASTE_CONFIRM_LINES = 3;
const MAX_TERMINALS = 16;

export interface TerminalEntry {
  id: number;
  name: string;
  /** What the shell last set as its title. */
  title: string;
  profile: TerminalProfile;
  isPty: boolean;
  fallbackReason?: string;
  cwd: string;
  exit: { code: number | null } | null;
  /** Set for terminals started by a task, so the same task reuses its terminal. */
  taskId?: string;
}

interface TerminalsState {
  terminals: TerminalEntry[];
  activeId: number | null;
  profiles: TerminalProfile[] | null;
  /** Why the terminal cannot be used right now, in plain language. */
  blocked: { kind: 'policy' | 'untrusted'; message: string } | null;
  error: string | null;
  /** Profile chosen for this session with "Select default shell". */
  sessionProfileId: string | null;
}

export const useTerminals = create<TerminalsState>(() => ({
  terminals: [],
  activeId: null,
  profiles: null,
  blocked: null,
  error: null,
  sessionProfileId: null,
}));

interface View {
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  /** The element xterm renders into; moved into the panel by the React component. */
  element: HTMLDivElement;
  opened: boolean;
  ackPending: number;
  ackTimer: ReturnType<typeof setTimeout> | undefined;
}

const views = new Map<number, View>();

const get = () => useTerminals.getState();
const patch = (change: Partial<TerminalsState>) => useTerminals.setState(change);

export function viewFor(id: number): View | undefined {
  return views.get(id);
}

// --- theme and options ----------------------------------------------------------------------

function css(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The terminal colours from the design tokens (read again when the theme changes). */
export function terminalTheme(): ITheme {
  return {
    background: css('--terminal-bg'),
    foreground: css('--terminal-fg'),
    cursor: css('--terminal-cursor'),
    cursorAccent: css('--terminal-bg'),
    selectionBackground: css('--terminal-selection'),
    black: css('--ansi-black'),
    red: css('--ansi-red'),
    green: css('--ansi-green'),
    yellow: css('--ansi-yellow'),
    blue: css('--ansi-blue'),
    magenta: css('--ansi-magenta'),
    cyan: css('--ansi-cyan'),
    white: css('--ansi-white'),
    brightBlack: css('--ansi-bright-black'),
    brightRed: css('--ansi-bright-red'),
    brightGreen: css('--ansi-bright-green'),
    brightYellow: css('--ansi-bright-yellow'),
    brightBlue: css('--ansi-bright-blue'),
    brightMagenta: css('--ansi-bright-magenta'),
    brightCyan: css('--ansi-bright-cyan'),
    brightWhite: css('--ansi-bright-white'),
  };
}

function fontFamily(): string {
  return getSetting('terminal.fontFamily') || getSetting('editor.fontFamily');
}

function fontSize(): number {
  return getSetting('terminal.fontSize') || getSetting('editor.fontSize');
}

/** Apply the current settings and theme to every terminal. */
export function refreshAppearance(): void {
  const theme = terminalTheme();
  for (const view of views.values()) {
    view.term.options.theme = theme;
    view.term.options.fontFamily = fontFamily();
    view.term.options.fontSize = fontSize();
    view.term.options.cursorStyle = getSetting('terminal.cursorStyle');
    view.term.options.scrollback = getSetting('terminal.scrollback');
    if (view.opened) fitView(view);
  }
}

// --- sizing ---------------------------------------------------------------------------------

const resizeTimers = new Map<number, ReturnType<typeof setTimeout>>();

function fitView(view: View): void {
  const parent = view.element.parentElement;
  if (!parent || parent.clientWidth === 0 || parent.clientHeight === 0) return;
  try {
    view.fit.fit();
  } catch {
    /* the container has no size yet */
  }
}

/** Fit a terminal to its container and tell the shell the new size. */
export function resizeTerminal(id: number): void {
  const view = views.get(id);
  if (!view) return;
  clearTimeout(resizeTimers.get(id));
  resizeTimers.set(
    id,
    setTimeout(() => {
      fitView(view);
      const entry = get().terminals.find((t) => t.id === id);
      if (entry && !entry.exit && view.term.cols > 0 && view.term.rows > 0) {
        void ipc
          .invoke('terminal:resize', id, view.term.cols, view.term.rows)
          .catch(() => undefined);
      }
    }, 40),
  );
}

// --- data flow ------------------------------------------------------------------------------

function acknowledge(view: View, id: number, count: number): void {
  view.ackPending += count;
  if (view.ackPending >= ACK_BATCH) flushAck(view, id);
  else if (!view.ackTimer) view.ackTimer = setTimeout(() => flushAck(view, id), 100);
}

function flushAck(view: View, id: number): void {
  if (view.ackTimer) clearTimeout(view.ackTimer);
  view.ackTimer = undefined;
  const count = view.ackPending;
  view.ackPending = 0;
  if (count > 0) void ipc.invoke('terminal:ack', id, count).catch(() => undefined);
}

export function onData(event: { id: number; data: string }): void {
  const view = views.get(event.id);
  if (!view) return;
  const length = event.data.length;
  view.term.write(event.data, () => acknowledge(view, event.id, length));
}

export function onExit(event: { id: number; exitCode: number | null }): void {
  const view = views.get(event.id);
  patch({
    terminals: get().terminals.map((t) =>
      t.id === event.id ? { ...t, exit: { code: event.exitCode } } : t,
    ),
  });
  view?.term.write(
    `\r\n\x1b[2mProcess exited${event.exitCode === null ? '' : ` with code ${event.exitCode}`}.\x1b[0m\r\n`,
  );
}

export function onTitle(event: { id: number; title: string }): void {
  patch({
    terminals: get().terminals.map((t) => (t.id === event.id ? { ...t, title: event.title } : t)),
  });
}

// --- clipboard ------------------------------------------------------------------------------

export async function copySelection(id: number): Promise<boolean> {
  const text = views.get(id)?.term.getSelection() ?? '';
  return text ? copyText(text) : false;
}

/** Paste text, asking first when it spans several lines (a stray paste would run commands). */
export async function pasteText(id: number, text: string): Promise<void> {
  const view = views.get(id);
  if (!view || text === '') return;
  const lines = text.split(/\r\n|\r|\n/).length;
  if (lines > PASTE_CONFIRM_LINES) {
    const ok = await service('dialogs').confirm({
      title: `Paste ${lines} lines into the terminal?`,
      message: 'Each line will be sent to the shell and may run as a command.',
      confirmLabel: 'Paste',
    });
    if (!ok) return;
  }
  view.term.paste(text);
}

export async function pasteFromClipboard(id: number): Promise<void> {
  try {
    await pasteText(id, await navigator.clipboard.readText());
  } catch {
    service('notifications').warn(
      'Could not read the clipboard.',
      'Allow clipboard access and try again.',
    );
  }
}

// --- lifecycle ------------------------------------------------------------------------------

function makeView(id: number): View {
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: fontFamily(),
    fontSize: fontSize(),
    cursorStyle: getSetting('terminal.cursorStyle'),
    cursorBlink: true,
    scrollback: getSetting('terminal.scrollback'),
    theme: terminalTheme(),
    rightClickSelectsWord: false,
    macOptionIsMeta: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 4.5,
    cols: 80,
    rows: 24,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      void ipc.invoke('app:openExternal', uri).catch(() => undefined);
    }),
  );

  const element = document.createElement('div');
  element.className = 'term-host';
  element.dataset.terminalId = String(id);
  const view: View = {
    term,
    fit,
    search,
    element,
    opened: false,
    ackPending: 0,
    ackTimer: undefined,
  };

  term.onData((data) => {
    const entry = get().terminals.find((t) => t.id === id);
    if (entry?.exit) return;
    void ipc.invoke('terminal:write', id, data).catch(() => undefined);
  });
  term.onSelectionChange(() => {
    if (getSetting('terminal.copyOnSelect') && term.hasSelection())
      void copyText(term.getSelection());
  });

  // Plain Ctrl+C and Escape must reach the shell. Copy and paste use the platform's terminal keys.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    const mac = navigator.platform.toLowerCase().includes('mac');
    const key = event.key.toLowerCase();
    const copy = mac
      ? event.metaKey && key === 'c'
      : event.ctrlKey && event.shiftKey && key === 'c';
    const paste = mac
      ? event.metaKey && key === 'v'
      : event.ctrlKey && event.shiftKey && key === 'v';
    if (copy) {
      event.preventDefault();
      void copySelection(id);
      return false;
    }
    if (paste) {
      event.preventDefault();
      void pasteFromClipboard(id);
      return false;
    }
    return true;
  });

  // Paste events (the context menu, middle click) go through the same confirmation.
  element.addEventListener(
    'paste',
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      void pasteText(id, event.clipboardData?.getData('text') ?? '');
    },
    true,
  );

  // File references in output ("src/app.ts:12:5") open the file at that position.
  term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const buffer = term.buffer.active;
      const text = buffer.getLine(lineNumber - 1)?.translateToString(true) ?? '';
      const candidates = findPathLinks(text);
      if (candidates.length === 0) return callback(undefined);
      const cwd =
        get().terminals.find((t) => t.id === id)?.cwd ??
        useWorkspaceStore.getState().workspace?.root ??
        '';
      void Promise.all(
        candidates.map(async (candidate) => {
          const path = resolveLinkPath(candidate.path, cwd, isWindows);
          try {
            const stat = await ipc.invoke('fs:stat', path);
            return stat.kind === 'file' ? { candidate, path } : null;
          } catch {
            return null;
          }
        }),
      ).then((checked) =>
        callback(
          checked
            .filter((c): c is NonNullable<typeof c> => c !== null)
            .map(({ candidate, path }) => ({
              range: {
                start: { x: candidate.start + 1, y: lineNumber },
                end: { x: candidate.end + 1, y: lineNumber },
              },
              text: text.slice(candidate.start, candidate.end),
              activate: () => {
                void service('commands').execute('editor.openFile', {
                  path,
                  line: candidate.line,
                  column: candidate.column,
                });
              },
            })),
        ),
      );
    },
  });

  views.set(id, view);
  return view;
}

/** Attach a terminal's element to a container and size it. Called by the panel. */
export function mountTerminal(id: number, container: HTMLElement): void {
  const view = views.get(id);
  if (!view) return;
  if (view.element.parentElement !== container) container.appendChild(view.element);
  if (!view.opened) {
    view.term.open(view.element);
    view.opened = true;
  }
  resizeTerminal(id);
}

export async function loadProfiles(): Promise<TerminalProfile[]> {
  const existing = get().profiles;
  if (existing) return existing;
  const profiles = await ipc.invoke('terminal:listProfiles');
  patch({ profiles });
  return profiles;
}

export interface CreateOptions {
  profileId?: string;
  name?: string;
  cwd?: string;
  initialCommand?: string;
  taskId?: string;
}

/** Start a shell. Returns its id, or null when it could not start (the panel explains why). */
export async function createTerminal(options: CreateOptions = {}): Promise<number | null> {
  if (get().terminals.length >= MAX_TERMINALS) {
    service('notifications').warn(
      `You can have ${MAX_TERMINALS} terminals open at once.`,
      'Close one to open another.',
    );
    return null;
  }
  try {
    const info = await ipc.invoke('terminal:create', {
      cols: 80,
      rows: 24,
      profileId: options.profileId ?? get().sessionProfileId ?? undefined,
      cwd: options.cwd,
      name: options.name,
      initialCommand: options.initialCommand,
    });
    makeView(info.id);
    const entry: TerminalEntry = {
      id: info.id,
      name: info.name,
      title: '',
      profile: info.profile,
      isPty: info.isPty,
      fallbackReason: info.fallbackReason,
      cwd: info.cwd,
      exit: null,
      taskId: options.taskId,
    };
    patch({
      terminals: [...get().terminals, entry],
      activeId: info.id,
      blocked: null,
      error: null,
    });
    return info.id;
  } catch (error) {
    if (isIncError(error, 'E_POLICY')) {
      patch({
        blocked: { kind: 'policy', message: 'The terminal is turned off by your organization.' },
      });
    } else if (isIncError(error, 'E_UNTRUSTED')) {
      patch({
        blocked: {
          kind: 'untrusted',
          message: 'Trust this folder to open a terminal. Shells can run any command in it.',
        },
      });
    } else {
      patch({ error: describeError(error) });
    }
    return null;
  }
}

export function setActive(id: number): void {
  if (get().activeId !== id) patch({ activeId: id });
}

export function activateOffset(step: 1 | -1): void {
  const { terminals, activeId } = get();
  if (terminals.length === 0) return;
  const index = terminals.findIndex((t) => t.id === activeId);
  const next = terminals[(index + step + terminals.length) % terminals.length];
  if (next) patch({ activeId: next.id });
}

export function disposeTerminal(id: number): void {
  const view = views.get(id);
  if (view) {
    flushAck(view, id);
    view.term.dispose();
    view.element.remove();
    views.delete(id);
  }
  clearTimeout(resizeTimers.get(id));
  resizeTimers.delete(id);
  const remaining = get().terminals.filter((t) => t.id !== id);
  const closedIndex = get().terminals.findIndex((t) => t.id === id);
  const activeId =
    get().activeId === id
      ? (remaining[Math.min(closedIndex, remaining.length - 1)]?.id ?? null)
      : get().activeId;
  patch({ terminals: remaining, activeId });
}

/** Stop a shell (and whatever it started) and remove its tab. */
export async function closeTerminal(id: number): Promise<void> {
  const entry = get().terminals.find((t) => t.id === id);
  if (entry && !entry.exit) await ipc.invoke('terminal:kill', id).catch(() => undefined);
  disposeTerminal(id);
}

export async function restartTerminal(id: number): Promise<void> {
  const entry = get().terminals.find((t) => t.id === id);
  if (!entry) return;
  const options: CreateOptions = {
    profileId: entry.profile.id,
    name: entry.name,
    cwd: entry.cwd,
    taskId: entry.taskId,
  };
  disposeTerminal(id);
  await createTerminal(options);
}

export function clearTerminal(id: number): void {
  views.get(id)?.term.clear();
}

export function focusTerminal(id: number): void {
  views.get(id)?.term.focus();
}

export function selectAll(id: number): void {
  views.get(id)?.term.selectAll();
}

export function hasSelection(id: number): boolean {
  return views.get(id)?.term.hasSelection() ?? false;
}

export function setSessionProfile(profileId: string | null): void {
  patch({ sessionProfileId: profileId });
}

/** Run a task in its own terminal, reusing the one it used before while that is still running. */
export async function runTask(task: TaskDefinition): Promise<void> {
  const existing = get().terminals.find((t) => t.taskId === task.id && !t.exit);
  if (existing) {
    patch({ activeId: existing.id });
    await ipc.invoke('terminal:write', existing.id, `${task.command}\r`).catch(() => undefined);
    return;
  }
  await createTerminal({
    name: task.label,
    cwd: task.cwd,
    initialCommand: task.command,
    taskId: task.id,
  });
}
