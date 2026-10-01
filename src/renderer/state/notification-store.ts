import { create } from 'zustand';
import type {
  NotificationAction,
  NotificationLevel,
  NotificationOptions,
  NotificationService,
} from '../contracts/layout';

export interface NotificationItem {
  id: number;
  level: NotificationLevel;
  message: string;
  detail?: string;
  actions: NotificationAction[];
  /** Milliseconds; 0 keeps it until dismissed. */
  timeout: number;
  key?: string;
}

/** Toasts shown at once; newer ones push older ones out of view until room frees up. */
export const MAX_VISIBLE_TOASTS = 3;
const DEFAULT_TIMEOUT_MS = 6000;

interface NotificationState {
  items: NotificationItem[];
}

export const useNotificationStore = create<NotificationState>(() => ({ items: [] }));

let nextId = 1;

function dismiss(id: number): void {
  useNotificationStore.setState((s) => ({ items: s.items.filter((i) => i.id !== id) }));
}

export function createNotificationService(): NotificationService {
  const notify = (options: NotificationOptions) => {
    const level = options.level ?? 'info';
    const item: NotificationItem = {
      id: nextId++,
      level,
      message: options.message,
      detail: options.detail,
      actions: options.actions ?? [],
      timeout: options.timeout ?? (level === 'error' ? 0 : DEFAULT_TIMEOUT_MS),
      key: options.key,
    };
    useNotificationStore.setState((s) => ({
      items: [...(item.key ? s.items.filter((i) => i.key !== item.key) : s.items), item],
    }));
    return { dismiss: () => dismiss(item.id) };
  };
  return {
    notify,
    info: (message, detail) => void notify({ level: 'info', message, detail }),
    warn: (message, detail) => void notify({ level: 'warning', message, detail }),
    error: (message, detail) => void notify({ level: 'error', message, detail }),
  };
}

export function dismissNotification(id: number): void {
  dismiss(id);
}
