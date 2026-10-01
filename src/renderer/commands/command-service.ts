import { commandById } from '@shared/commands/catalog';
import { describeError, isIncError } from '@shared/errors';
import type { CommandService, ContextKeyService, Unsubscribe } from '../contracts/commands';

type Handler = (args?: never) => unknown | Promise<unknown>;

export interface CommandServiceDeps {
  contextKeys: ContextKeyService;
  /** Reports a failure to the person using the app. Optional: the notification service may not exist yet. */
  notify: (level: 'info' | 'error', message: string, detail?: string) => void;
  /** Diagnostic sink for the main-process log. */
  log: (level: 'warn' | 'error', message: string) => void;
}

function titleOf(id: string): string {
  const def = commandById(id);
  if (!def) return id;
  return def.category ? `${def.category}: ${def.title}` : def.title;
}

/**
 * The command bus. Handlers are registered by the slice that owns the feature; the newest
 * registration for an id wins and unregistering restores the previous one.
 *
 * `execute` never rejects: a missing handler or a failing handler is reported through the
 * notification service and the log, then the promise resolves with `undefined`.
 */
export function createCommandService(deps: CommandServiceDeps): CommandService {
  const handlers = new Map<string, Handler[]>();

  const handlerFor = (id: string): Handler | undefined => {
    const stack = handlers.get(id);
    return stack?.[stack.length - 1];
  };

  const service: CommandService = {
    register(id, handler): Unsubscribe {
      const stack = handlers.get(id) ?? [];
      stack.push(handler);
      handlers.set(id, stack);
      return () => {
        const current = handlers.get(id);
        if (!current) return;
        const index = current.lastIndexOf(handler);
        if (index !== -1) current.splice(index, 1);
        if (current.length === 0) handlers.delete(id);
      };
    },

    async execute(id: string, args?: unknown): Promise<unknown> {
      const handler = handlerFor(id);
      if (!handler) {
        deps.notify('info', `${titleOf(id)} is not available yet.`, 'This command has no handler.');
        return undefined;
      }
      try {
        return await (handler as (args?: unknown) => unknown)(args);
      } catch (error) {
        if (isIncError(error, 'E_CANCELLED')) return undefined;
        const detail = describeError(error);
        deps.log('error', `Command ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
        deps.notify('error', `Could not run ${titleOf(id)}.`, detail);
        return undefined;
      }
    },

    has(id) {
      return handlerFor(id) !== undefined;
    },

    isEnabled(id) {
      if (!handlerFor(id)) return false;
      return deps.contextKeys.evaluate(commandById(id)?.when);
    },
  };
  return service;
}
