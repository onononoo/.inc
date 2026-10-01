/**
 * Renderer log sink: validates what the renderer wants written to the log folder. A page can
 * neither forge log lines (line breaks are flattened), nor flood the disk (messages are capped
 * and each window gets a message budget per time slice).
 */
import { IncError } from '@shared/errors';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const MAX_LOG_MESSAGE = 4_000;
export const LOG_BUDGET = 200;
export const LOG_BUDGET_WINDOW_MS = 10_000;

export function cleanLogMessage(value: unknown): string {
  if (typeof value !== 'string') throw new IncError('E_INVALID', 'Log message must be a string.');
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ');
  return flat.length > MAX_LOG_MESSAGE ? `${flat.slice(0, MAX_LOG_MESSAGE)}... (truncated)` : flat;
}

export function cleanLogLevel(value: unknown): LogLevel {
  if (typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }
  throw new IncError('E_INVALID', 'Log level must be debug, info, warn or error.');
}

export type BudgetDecision = 'accept' | 'drop' | 'dropped-summary';

/** Per-window message budget. After the budget is spent the next slice reports how many were dropped. */
export class LogBudget {
  private sliceStart = 0;
  private used = 0;
  private dropped = 0;

  constructor(
    private readonly limit = LOG_BUDGET,
    private readonly sliceMs = LOG_BUDGET_WINDOW_MS,
  ) {}

  take(now: number): { decision: BudgetDecision; dropped: number } {
    if (now - this.sliceStart >= this.sliceMs) {
      const dropped = this.dropped;
      this.sliceStart = now;
      this.used = 1;
      this.dropped = 0;
      return dropped > 0
        ? { decision: 'dropped-summary', dropped }
        : { decision: 'accept', dropped: 0 };
    }
    if (this.used < this.limit) {
      this.used++;
      return { decision: 'accept', dropped: 0 };
    }
    this.dropped++;
    return { decision: 'drop', dropped: 0 };
  }
}
