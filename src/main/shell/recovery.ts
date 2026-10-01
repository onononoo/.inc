/**
 * Plain-language recovery dialogs for a renderer that crashed or stopped responding.
 * Pure: the strings and the decisions only; the controller shows the dialog.
 */

export type RecoveryKind = 'crashed' | 'unresponsive';
export type RecoveryChoice = 'reload' | 'close' | 'wait';

export interface RecoveryDialog {
  message: string;
  detail: string;
  /** Button labels in display order. */
  buttons: string[];
  /** Choice for each button, same order. */
  choices: RecoveryChoice[];
  /** Index of the default (focused) button. */
  defaultId: number;
  /** Index used when the dialog is dismissed. */
  cancelId: number;
}

export type GoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction';

/** Repeated crashes inside this window are treated as a crash loop. */
const LOOP_WINDOW_MS = 60_000;
const LOOP_LIMIT = 3;

export class CrashTracker {
  private times: number[] = [];

  /** Record a crash and report whether the window is now crash-looping. */
  record(now: number): boolean {
    this.times = this.times.filter((t) => now - t < LOOP_WINDOW_MS);
    this.times.push(now);
    return this.times.length >= LOOP_LIMIT;
  }
}

function crashCause(reason: GoneReason | undefined): string {
  switch (reason) {
    case 'oom':
    case 'memory-eviction':
      return 'It ran out of memory.';
    case 'killed':
      return 'Its process was stopped by the system or another program.';
    case 'launch-failed':
      return 'Its process could not be started.';
    case 'integrity-failure':
      return 'A code integrity check failed.';
    default:
      return 'Its process ended unexpectedly.';
  }
}

export function recoveryDialog(
  kind: RecoveryKind,
  options: { reason?: GoneReason; crashLoop?: boolean } = {},
): RecoveryDialog {
  if (kind === 'unresponsive') {
    return {
      message: 'This window is not responding',
      detail:
        'You can wait for it to recover, reload it, or close it. ' +
        'Reloading or closing discards changes that have not been saved.',
      buttons: ['Wait', 'Reload window', 'Close window'],
      choices: ['wait', 'reload', 'close'],
      defaultId: 0,
      cancelId: 0,
    };
  }
  if (options.crashLoop) {
    return {
      message: 'This window keeps stopping',
      detail:
        `${crashCause(options.reason)} Reloading did not help. ` +
        'Close the window and restart the app. If it continues, copy the diagnostics from ' +
        'Help and send them to your administrator.',
      buttons: ['Close window'],
      choices: ['close'],
      defaultId: 0,
      cancelId: 0,
    };
  }
  return {
    message: 'This window stopped working',
    detail:
      `${crashCause(options.reason)} Changes that were not saved may be lost. ` +
      'Reload to continue, or close the window.',
    buttons: ['Reload window', 'Close window'],
    choices: ['reload', 'close'],
    defaultId: 0,
    cancelId: 1,
  };
}

export function choiceFor(dialog: RecoveryDialog, response: number): RecoveryChoice {
  return dialog.choices[response] ?? dialog.choices[dialog.cancelId] ?? 'close';
}
