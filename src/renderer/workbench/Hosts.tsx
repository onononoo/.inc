import { ContextMenu } from '../ui/ContextMenu';
import { Dialog } from '../ui/Dialog';
import { Toast } from '../ui/Toast';
import {
  MAX_VISIBLE_TOASTS,
  dismissNotification,
  useNotificationStore,
} from '../state/notification-store';
import { closeMenu, useDialogStore, useMenuStore } from './services';

/** Renders the top dialog of the stack. Dialogs opened from a dialog sit above it. */
export function DialogHost() {
  const stack = useDialogStore((s) => s.stack);
  const top = stack[stack.length - 1];
  if (!top) return null;
  return (
    <Dialog
      key={top.id}
      title={top.title}
      width={top.width}
      role={top.role}
      actions={top.actions}
      onClose={top.onEscape}
    >
      {top.body}
    </Dialog>
  );
}

/** Renders the open context menu, if any. */
export function MenuHost() {
  const request = useMenuStore((s) => s.request);
  if (!request) return null;
  return <ContextMenu items={request.items} position={request.position} onClose={closeMenu} />;
}

/** Bottom-right stack of notifications, at most three at a time. */
export function ToastHost() {
  const items = useNotificationStore((s) => s.items);
  const visible = items.slice(-MAX_VISIBLE_TOASTS);
  if (visible.length === 0) return null;
  return (
    <div className="wb-toasts" aria-label="Notifications">
      {visible.map((item) => (
        <Toast
          key={item.id}
          level={item.level}
          message={item.message}
          detail={item.detail}
          actions={item.actions}
          timeout={item.timeout}
          onDismiss={() => dismissNotification(item.id)}
        />
      ))}
    </div>
  );
}
