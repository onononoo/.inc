import { QuickInputController } from './quick-input-controller';
import { Store } from './store';

/** The one quick input state machine; the host component renders it and the service drives it. */
export const quickInput = new QuickInputController();

/** Text shown while a two-step chord is waiting for its second key; null when nothing is pending. */
export const chordHint = new Store<string | null>(null);
