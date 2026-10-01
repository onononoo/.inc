import { register as commands } from './commands/register';
import { register as editor } from './editor/register';
import { register as explorer } from './explorer/register';
import { register as scm } from './scm/register';
import { register as search } from './search/register';
import { register as settingsUi } from './settings-ui/register';
import { register as terminal } from './terminal/register';
import { register as workbench } from './workbench/register';

/**
 * Order matters: commands and workbench provide the services the others use (commands,
 * context keys, dialogs, menus, notifications, status bar), then the feature slices register.
 */
export function registerAllSlices(): void {
  commands();
  workbench();
  editor();
  explorer();
  search();
  scm();
  terminal();
  settingsUi();
}
