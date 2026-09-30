import { describe, it, expect } from 'vitest';
import { validateWebhookBody } from './validate';

describe('validateWebhookBody', () => {
  it('extracts the donation item id and board id from a valid event', () => {
    const result = validateWebhookBody({ event: { type: 'create_pulse', pulseId: 42, boardId: 1 } });
    expect(result.donationItemId).toBe('42');
    expect(result.boardId).toBe('1');
  });

  it('accepts string pulseId and boardId too', () => {
    const result = validateWebhookBody({ event: { type: 'update_column_value', pulseId: '99', boardId: '7' } });
    expect(result.donationItemId).toBe('99');
    expect(result.boardId).toBe('7');
  });

  it('rejects a body with no event object', () => {
    expect(() => validateWebhookBody({})).toThrow(/no "event" object/);
  });

  it('rejects an event with no pulseId', () => {
    expect(() => validateWebhookBody({ event: { type: 'create_pulse', boardId: 1 } })).toThrow(/pulseId/);
  });

  it('rejects an event with no boardId', () => {
    expect(() => validateWebhookBody({ event: { type: 'create_pulse', pulseId: 1 } })).toThrow(/boardId/);
  });

  it('rejects a non-object body', () => {
    expect(() => validateWebhookBody(null)).toThrow();
    expect(() => validateWebhookBody('a string')).toThrow();
  });

  it('carries columnId for a column-change event, null otherwise', () => {
    expect(validateWebhookBody({ event: { type: 'update_column_value', pulseId: 5, boardId: 1, columnId: 'fs' } }).columnId).toBe('fs');
    expect(validateWebhookBody({ event: { type: 'create_pulse', pulseId: 5, boardId: 1 } }).columnId).toBeNull();
  });
});
