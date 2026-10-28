import { describe, it, expect } from 'vitest';
import { isTerminalError, TerminalError } from './errors';
import { AmbiguousWriteError, MondayApiError } from './monday/graphql';

describe('isTerminalError (#75)', () => {
  it('is true for a TerminalError', () => {
    expect(isTerminalError(new TerminalError('bad'))).toBe(true);
  });

  it.each([400, 404, 422])('is true for a Monday HTTP %i', (httpStatus) => {
    expect(isTerminalError(new MondayApiError(`monday API: HTTP ${httpStatus}`, { httpStatus }))).toBe(true);
  });

  it.each([401, 403, 408, 409, 429])('is false for a Monday HTTP %i (token, timeout, conflict, rate limit)', (httpStatus) => {
    expect(isTerminalError(new MondayApiError(`monday API: HTTP ${httpStatus}`, { httpStatus }))).toBe(false);
  });

  it('is true for a column value Monday rejects in a 200 errors response', () => {
    const err = new MondayApiError('monday API: invalid value', { httpStatus: 200, code: 'ColumnValueException' });
    expect(isTerminalError(err)).toBe(true);
  });

  it('is false for UserUnauthorizedException — Monday also says it for a deleted board, which a config fix heals', () => {
    const err = new MondayApiError('monday API: User unauthorized to perform action', { httpStatus: 200, code: 'UserUnauthorizedException' });
    expect(isTerminalError(err)).toBe(false);
  });

  it('is false for the daily limit, a 5xx, or a write that may have committed', () => {
    expect(isTerminalError(new MondayApiError('monday API: daily limit', { httpStatus: 429, code: 'DAILY_LIMIT_EXCEEDED' }))).toBe(false);
    expect(isTerminalError(new MondayApiError('monday API: HTTP 503', { httpStatus: 503 }))).toBe(false);
    expect(isTerminalError(new AmbiguousWriteError('monday API: HTTP 400 (the write may have committed)', { httpStatus: 400 }))).toBe(false);
  });

  it('is false for anything else', () => {
    expect(isTerminalError(new Error('D1_ERROR: overloaded'))).toBe(false);
    expect(isTerminalError('boom')).toBe(false);
  });
});
