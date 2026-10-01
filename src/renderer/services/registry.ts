import type {
  CommandService,
  ContextKeyService,
  KeybindingService,
  QuickInputService,
} from '../contracts/commands';
import type { EditorHost, EditorService } from '../contracts/editor';
import type {
  DialogService,
  LayoutService,
  MenuService,
  NotificationService,
  StatusBarService,
} from '../contracts/layout';

/** Every cross-slice service. Each slice provides the ones it owns from its `register.ts`. */
export interface Services {
  commands: CommandService;
  contextKeys: ContextKeyService;
  keybindings: KeybindingService;
  quickInput: QuickInputService;
  layout: LayoutService;
  notifications: NotificationService;
  dialogs: DialogService;
  menus: MenuService;
  statusBar: StatusBarService;
  editor: EditorService;
  editorHost: EditorHost;
}

const impl: Partial<Services> = {};

export function provide<K extends keyof Services>(key: K, value: Services[K]): void {
  impl[key] = value;
}

/** Look up a service. Throws with a clear message if its slice has not provided it yet. */
export function service<K extends keyof Services>(key: K): Services[K] {
  const value = impl[key];
  if (!value) throw new Error(`Service "${key}" has not been provided`);
  return value as Services[K];
}

export function hasService(key: keyof Services): boolean {
  return impl[key] !== undefined;
}
