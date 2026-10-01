import { cx } from './cx';

/**
 * Splits a keybinding label into its keys, grouped by chord step.
 *   "Ctrl+Shift+P"      -> [["Ctrl", "Shift", "P"]]
 *   "Ctrl+K Ctrl+S"     -> [["Ctrl", "K"], ["Ctrl", "S"]]
 *   "Ctrl++"            -> [["Ctrl", "+"]]
 *   Mac symbol labels   -> one key per symbol (shift, command, then the letter)
 */
export function splitKeys(label: string): string[][] {
  const trimmed = label.trim();
  if (!trimmed) return [];
  return trimmed.split(/\s+/).map((step) => {
    if (step.includes('+') && step.length > 1) {
      const keys: string[] = [];
      let current = '';
      for (let i = 0; i < step.length; i++) {
        const ch = step[i] as string;
        if (ch === '+' && current !== '') {
          keys.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      if (current !== '') keys.push(current);
      return keys;
    }
    // macOS symbol labels have no separators: every symbol is a key.
    if (/[\u2318\u21e7\u2325\u2303]/.test(step)) return Array.from(step);
    return [step];
  });
}

export interface KbdProps {
  /** Label such as "Ctrl+Shift+P", as returned by the keybinding service. */
  keys: string;
  className?: string;
}

/** Keybinding chips: 18px tall, one chip per key. */
export function Kbd({ keys, className }: KbdProps) {
  const steps = splitKeys(keys);
  if (steps.length === 0) return null;
  return (
    <span className={cx('ui-kbd-group', className)} aria-label={keys} role="img">
      {steps.map((step, i) => (
        <span className="ui-kbd-step" key={i} aria-hidden="true">
          {step.map((key, j) => (
            <kbd className="ui-kbd" key={j}>
              {key}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  );
}
