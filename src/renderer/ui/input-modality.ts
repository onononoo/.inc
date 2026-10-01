/**
 * Remembers whether the most recent user input came from the keyboard or a pointer, so surfaces
 * opened without an explicit trigger (a context menu from the menu key or from a click) can
 * decide whether to move focus into themselves right away.
 */
let keyboard = false;
let installed = false;

export function installInputModality(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener(
    'keydown',
    (event) => {
      // Modifier presses alone do not count: they happen during mouse gestures too.
      if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') {
        return;
      }
      keyboard = true;
    },
    true,
  );
  window.addEventListener('pointerdown', () => (keyboard = false), true);
}

export function lastInputWasKeyboard(): boolean {
  return keyboard;
}
