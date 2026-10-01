import type { Disposable, Kernel } from '../kernel';

/** Terminal slice: PTY sessions, shell profiles and task listing. */
export function register(kernel: Kernel): Disposable {
  void kernel;
  return () => undefined;
}
