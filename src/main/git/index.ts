import type { Disposable, Kernel } from '../kernel';

/** Git slice: Git CLI service with status/diff/stage/commit/branch operations and change events. */
export function register(kernel: Kernel): Disposable {
  void kernel;
  return () => undefined;
}
