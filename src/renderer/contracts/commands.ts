import type { CommandArgs } from '@shared/commands/catalog';
import type { ContextValue } from '@shared/when';

export type Unsubscribe = () => void;

/** Owned by the commands slice (`renderer/commands`). */
export interface CommandService {
  /** Register the handler for a catalog command id. Returns an unregister function. */
  register(id: string, handler: (args?: never) => unknown | Promise<unknown>): Unsubscribe;
  execute<K extends keyof CommandArgs>(id: K, args?: CommandArgs[K]): Promise<unknown>;
  execute(id: string, args?: unknown): Promise<unknown>;
  has(id: string): boolean;
  /** True when the command exists, has a handler and its `when` clause is satisfied. */
  isEnabled(id: string): boolean;
}

export interface ContextKeyService {
  set(key: string, value: ContextValue): void;
  get(key: string): ContextValue;
  /** Evaluate a when clause against current context. */
  evaluate(when: string | undefined): boolean;
  onDidChange(cb: (keys: string[]) => void): Unsubscribe;
}

export interface ResolvedKeybinding {
  commandId: string;
  /** Normalised chord for this platform, e.g. "Mod+Shift+P". */
  chord: string;
  when?: string;
  source: 'default' | 'user';
}

export interface KeybindingService {
  /** Begin listening for keyboard input (called once at startup). */
  start(): Unsubscribe;
  all(): ResolvedKeybinding[];
  /** Human-readable label for a command's binding, e.g. "Ctrl+Shift+P" or "⇧⌘P"; undefined when unbound. */
  labelFor(commandId: string): string | undefined;
  onDidChange(cb: () => void): Unsubscribe;
}

export interface QuickPickItem<T = unknown> {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  /** Keybinding label shown on the right. */
  keybinding?: string;
  /** Indexes into `label` to highlight. */
  highlights?: number[];
  /** Group heading rendered above the first item of a group. */
  group?: string;
  /** Icon name from the shared icon set. */
  icon?: string;
  value?: T;
}

export interface QuickPickOptions {
  placeholder?: string;
  title?: string;
  /** Filter items by fuzzy match on label/description. Default true. */
  filter?: boolean;
  /** Item ids to mark as current. */
  activeIds?: string[];
  /** Initial text in the input. */
  initialValue?: string;
  /** Called when the highlighted item changes, for live previews (a theme, a font size). */
  onActiveChange?: (item: QuickPickItem | undefined) => void;
}

export interface InputBoxOptions {
  title?: string;
  placeholder?: string;
  value?: string;
  prompt?: string;
  password?: boolean;
  /** Return an error message to block submission. */
  validate?: (value: string) => string | undefined | Promise<string | undefined>;
}

/** Owned by the commands slice. Renders the quick-input surface (palette, quick open, pickers). */
export interface QuickInputService {
  pick<T = unknown>(
    items:
      QuickPickItem<T>[] | ((query: string) => QuickPickItem<T>[] | Promise<QuickPickItem<T>[]>),
    options?: QuickPickOptions,
  ): Promise<QuickPickItem<T> | undefined>;
  input(options: InputBoxOptions): Promise<string | undefined>;
  /** Open the command palette (optionally prefilled, e.g. ">" for commands). */
  showCommandPalette(): void;
  showQuickOpen(initial?: string): void;
}
