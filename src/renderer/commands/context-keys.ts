import { evaluateWhen, type ContextValue } from '@shared/when';
import type { ContextKeyService, Unsubscribe } from '../contracts/commands';

/** Holds the context values that when-clauses read. Setting a value to what it already is does nothing. */
export function createContextKeyService(): ContextKeyService {
  const values = new Map<string, ContextValue>();
  const listeners = new Set<(keys: string[]) => void>();

  const get = (key: string): ContextValue => values.get(key);

  return {
    set(key, value) {
      if (values.get(key) === value) return;
      values.set(key, value);
      for (const listener of [...listeners]) listener([key]);
    },
    get,
    evaluate(when) {
      return evaluateWhen(when, get);
    },
    onDidChange(cb): Unsubscribe {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
