import type { Disposable, Kernel } from '../kernel';

/** Settings slice: layered settings service, enterprise policy, keybindings.json. Replaces kernel.settings and kernel.policy. */
export function register(kernel: Kernel): Disposable {
  void kernel;
  return () => undefined;
}
