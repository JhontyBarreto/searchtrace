import { describe, expect, it } from 'vitest';
import { ExitCode, StError, exitCodeFor, exitCodeName, isStError, notImplemented } from '../../src/core/errors.js';
import type { ErrorCode } from '../../src/core/types.js';

describe('ExitCode (D18)', () => {
  it('has the agreed numbers', () => {
    expect([ExitCode.OK, ExitCode.ERROR, ExitCode.CONFIG, ExitCode.AUTH, ExitCode.PARTIAL]).toEqual([0, 1, 2, 3, 4]);
    expect([0, 1, 2, 3, 4].map((n) => exitCodeName(n as ExitCode))).toEqual(['ok', 'error', 'config', 'auth', 'partial']);
  });
});

describe('StError', () => {
  it('carries code, message, fix and the exit code for its class', () => {
    const e = new StError('permission', 'No access to sc-domain:example.com.', 'Add the robot as a user.');
    expect(e).toBeInstanceOf(Error);
    expect(isStError(e)).toBe(true);
    expect(e.name).toBe('StError');
    expect(e.code).toBe('permission');
    expect(e.message).toBe('No access to sc-domain:example.com.');
    expect(e.fix).toBe('Add the robot as a user.');
    expect(e.exit).toBe(ExitCode.AUTH);
  });

  it('leaves fix undefined when not given and keeps a cause', () => {
    const cause = new Error('socket hang up');
    const e = new StError('network', 'Could not reach Google.', undefined, { cause });
    expect(e.fix).toBeUndefined();
    expect(e.cause).toBe(cause);
    expect(e.exit).toBe(ExitCode.ERROR);
  });

  it('maps every error code to an exit code', () => {
    const table: Record<ErrorCode, ExitCode> = {
      config: ExitCode.CONFIG,
      auth: ExitCode.AUTH,
      reauth_required: ExitCode.AUTH,
      permission: ExitCode.AUTH,
      property_not_found: ExitCode.AUTH,
      quota: ExitCode.PARTIAL,
      budget: ExitCode.OK,
      network: ExitCode.ERROR,
      http: ExitCode.ERROR,
      lock_held: ExitCode.ERROR,
      graph_not_ours: ExitCode.CONFIG,
      not_implemented: ExitCode.ERROR,
      internal: ExitCode.ERROR,
    };
    for (const [code, exit] of Object.entries(table)) expect(exitCodeFor(code as ErrorCode)).toBe(exit);
  });

  it('notImplemented throws StError(not_implemented) naming the function', () => {
    expect(() => notImplemented('fitCurve')).toThrowError(/fitCurve is not implemented yet/);
    try {
      notImplemented('fitCurve');
    } catch (e) {
      expect(isStError(e) && e.code).toBe('not_implemented');
    }
  });
});
