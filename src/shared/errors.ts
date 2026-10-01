/**
 * Error model shared by every process.
 *
 * Main-process IPC handlers simply throw. The IPC layer converts whatever was thrown into a
 * `SerializedError`, and the preload bridge re-throws it in the renderer as an `IncError`, so
 * renderer code can branch on `error.code` instead of parsing messages.
 */

export type ErrorCode =
  | 'E_NOT_FOUND'
  | 'E_EXISTS'
  | 'E_PERMISSION'
  | 'E_IS_DIRECTORY'
  | 'E_NOT_DIRECTORY'
  | 'E_MODIFIED_SINCE' // file changed on disk after it was read
  | 'E_TOO_LARGE'
  | 'E_POLICY' // blocked by an administrator policy
  | 'E_UNTRUSTED' // blocked because the workspace is not trusted
  | 'E_CANCELLED'
  | 'E_INVALID'
  | 'E_NO_WORKSPACE'
  | 'E_GIT_MISSING'
  | 'E_GIT'
  | 'E_IO'
  | 'E_NOT_IMPLEMENTED'
  | 'E_UNKNOWN';

export interface SerializedError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export class IncError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'IncError';
    this.code = code;
    this.details = details;
  }

  toJSON(): SerializedError {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isIncError(value: unknown, code?: ErrorCode): value is IncError {
  return value instanceof IncError && (code === undefined || value.code === code);
}

const ERRNO_MAP: Record<string, ErrorCode> = {
  ENOENT: 'E_NOT_FOUND',
  EEXIST: 'E_EXISTS',
  EACCES: 'E_PERMISSION',
  EPERM: 'E_PERMISSION',
  EROFS: 'E_PERMISSION',
  EISDIR: 'E_IS_DIRECTORY',
  ENOTDIR: 'E_NOT_DIRECTORY',
  ENOTEMPTY: 'E_EXISTS',
  EBUSY: 'E_IO',
  EMFILE: 'E_IO',
  ENOSPC: 'E_IO',
};

/** Normalise anything thrown (Node errno errors, strings, IncError) into an IncError. */
export function toIncError(value: unknown): IncError {
  if (value instanceof IncError) return value;
  if (value && typeof value === 'object') {
    const err = value as { code?: unknown; message?: unknown };
    const code = typeof err.code === 'string' ? ERRNO_MAP[err.code] : undefined;
    const message = typeof err.message === 'string' ? err.message : String(value);
    if (code) return new IncError(code, message, { errno: err.code });
    return new IncError('E_UNKNOWN', message);
  }
  return new IncError('E_UNKNOWN', String(value));
}

/** Short, human-readable text for showing an error to the user. */
export function describeError(value: unknown): string {
  const e = toIncError(value);
  switch (e.code) {
    case 'E_NOT_FOUND':
      return 'The file or folder no longer exists.';
    case 'E_EXISTS':
      return 'A file or folder with that name already exists.';
    case 'E_PERMISSION':
      return 'Permission denied.';
    case 'E_POLICY':
      return 'This action is disabled by your organization.';
    case 'E_UNTRUSTED':
      return 'This action requires a trusted workspace.';
    case 'E_TOO_LARGE':
      return 'The file is too large to open.';
    case 'E_MODIFIED_SINCE':
      return 'The file was changed on disk after it was opened.';
    case 'E_GIT_MISSING':
      return 'Git was not found. Install Git or set its path in settings.';
    default:
      return e.message;
  }
}
