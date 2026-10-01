import type { Disposable, Kernel } from './kernel';
import { register as registerFs } from './fs';
import { register as registerGit } from './git';
import { register as registerSearch } from './search';
import { register as registerSettings } from './settings';
import { register as registerShell } from './shell';
import { register as registerTerminal } from './terminal';
import { register as registerWorkspace } from './workspace';

/**
 * Slices register in dependency order: settings and workspace first (they replace the default
 * hosts on the kernel), then the services that read them.
 */
export function registerAll(kernel: Kernel): Disposable {
  const disposables = [
    registerSettings(kernel),
    registerWorkspace(kernel),
    registerShell(kernel),
    registerFs(kernel),
    registerSearch(kernel),
    registerGit(kernel),
    registerTerminal(kernel),
  ];
  return () => {
    for (const d of disposables.reverse()) {
      try {
        d();
      } catch (e) {
        kernel.logger.error('Error disposing slice', e);
      }
    }
  };
}
