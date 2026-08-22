import { describe, it, expect } from 'vitest';
import { isChallengeRequest, validateMondayEvent } from './validate';

describe('isChallengeRequest', () => {
  it('recognizes a challenge payload', () => {
    expect(isChallengeRequest({ challenge: 'abc123' })).toBe(true);
  });

  it('rejects a non-challenge payload', () => {
    expect(isChallengeRequest({ event: {} })).toBe(false);
    expect(isChallengeRequest(null)).toBe(false);
  });
});

describe('validateMondayEvent', () => {
  it('extracts mondayItemId, boardId, and columnValues from a valid event', () => {
    const result = validateMondayEvent({
      event: { pulseId: 123456, boardId: 789, columnValues: { text_col: 'Acme Co' } },
    });
    expect(result).toEqual({ mondayItemId: '123456', boardId: 789, columnValues: { text_col: 'Acme Co' } });
  });

  it('defaults columnValues to an empty object when absent', () => {
    const result = validateMondayEvent({ event: { pulseId: 1, boardId: 2 } });
    expect(result.columnValues).toEqual({});
  });

  it('throws when the body has no "event" object', () => {
    expect(() => validateMondayEvent({})).toThrow(/missing "event"/);
  });

  it('throws when pulseId is missing', () => {
    expect(() => validateMondayEvent({ event: { boardId: 2 } })).toThrow(/pulseId/);
  });

  it('throws when boardId is missing', () => {
    expect(() => validateMondayEvent({ event: { pulseId: 1 } })).toThrow(/boardId/);
  });
});
