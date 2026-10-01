import type { Disposable, Kernel } from '../kernel';

/** Search slice: worker-based text search and replace in files. */
export function register(kernel: Kernel): Disposable {
  void kernel;
  return () => undefined;
}
