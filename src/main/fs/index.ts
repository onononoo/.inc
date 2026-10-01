import type { Disposable, Kernel } from '../kernel';

/** File system slice: fs:* handlers, watcher, workspace file index (files:search), EditorConfig, encoding detection. */
export function register(kernel: Kernel): Disposable {
  void kernel;
  return () => undefined;
}
