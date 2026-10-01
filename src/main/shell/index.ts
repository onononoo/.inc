import type { Disposable, Kernel } from '../kernel';

/**
 * Shell slice: application menu, window management, dialogs, security hardening, diagnostics,
 * second-instance handling and external links.
 */
export function register(kernel: Kernel): Disposable {
  kernel.handle('app:getInfo', () => kernel.info);
  return () => undefined;
}
