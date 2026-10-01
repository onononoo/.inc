/**
 * Argument validation for IPC handlers. Every value that crosses the process boundary is
 * untrusted: check type and range before using it, and fail with a specific error code.
 */
import path from 'node:path';
import { IncError } from '@shared/errors';

export function requireString(value: unknown, name: string, maxLength = 4096): string {
  if (typeof value !== 'string') {
    throw new IncError('E_INVALID', `${name} must be a string.`);
  }
  if (value.length > maxLength) {
    throw new IncError('E_INVALID', `${name} is too long.`);
  }
  return value;
}

export function requireFiniteNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new IncError('E_INVALID', `${name} must be a finite number.`);
  }
  return value;
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    throw new IncError('E_INVALID', `${name} must be true or false.`);
  }
  return value;
}

export function requireOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  name: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new IncError('E_INVALID', `${name} is not one of: ${allowed.join(', ')}.`);
  }
  return value as T;
}

/** A non-empty absolute native path without NUL bytes. */
export function requireAbsolutePath(value: unknown, name: string): string {
  const text = requireString(value, name, 32_768);
  if (text.length === 0 || text.includes('\0') || !path.isAbsolute(text)) {
    throw new IncError('E_INVALID', `${name} must be an absolute path.`);
  }
  return text;
}

/** Absent values pass through as undefined; present values must be absolute paths. */
export function optionalAbsolutePath(value: unknown, name: string): string | undefined {
  return value === undefined || value === null ? undefined : requireAbsolutePath(value, name);
}

/** Options objects must be plain objects (or absent). */
export function optionalObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new IncError('E_INVALID', `${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}
