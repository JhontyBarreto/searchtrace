// Errors with a stable code, an optional one-line fix for the user, and the
// process exit code the CLI should use when the error ends a command (D18).
import type { ErrorCode, ExitCodeName } from './types.js';

export enum ExitCode {
  OK = 0,
  ERROR = 1,
  CONFIG = 2,
  AUTH = 3,
  PARTIAL = 4,
}

/** Exit code used when an error of this code ends a command. */
const EXIT_FOR: Record<ErrorCode, ExitCode> = {
  config: ExitCode.CONFIG,
  auth: ExitCode.AUTH,
  reauth_required: ExitCode.AUTH,
  permission: ExitCode.AUTH,
  property_not_found: ExitCode.AUTH,
  quota: ExitCode.PARTIAL,
  budget: ExitCode.OK, // a reached budget cap is a warning, not an alarm (D18)
  network: ExitCode.ERROR,
  http: ExitCode.ERROR,
  lock_held: ExitCode.ERROR,
  graph_not_ours: ExitCode.CONFIG,
  not_implemented: ExitCode.ERROR,
  internal: ExitCode.ERROR,
};

const EXIT_NAME: Record<ExitCode, ExitCodeName> = {
  [ExitCode.OK]: 'ok',
  [ExitCode.ERROR]: 'error',
  [ExitCode.CONFIG]: 'config',
  [ExitCode.AUTH]: 'auth',
  [ExitCode.PARTIAL]: 'partial',
};

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT_FOR[code] ?? ExitCode.ERROR;
}

export function exitCodeName(exit: ExitCode): ExitCodeName {
  return EXIT_NAME[exit] ?? 'error';
}

export class StError extends Error {
  readonly code: ErrorCode;
  readonly fix?: string;
  readonly exit: ExitCode;

  constructor(code: ErrorCode, message: string, fix?: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StError';
    this.code = code;
    if (fix !== undefined) this.fix = fix;
    this.exit = exitCodeFor(code);
  }
}

export function isStError(e: unknown): e is StError {
  return e instanceof StError;
}

/** Placeholder body for skeleton exports that have not been written yet. */
export function notImplemented(name: string): never {
  throw new StError('not_implemented', `${name} is not implemented yet.`);
}
