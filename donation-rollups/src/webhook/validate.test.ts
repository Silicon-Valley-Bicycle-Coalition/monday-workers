import { describe, it, expect } from 'vitest';
import { validateWebhookBody } from './validate';

describe('validateWebhookBody', () => {
  it('extracts the donation item id from a valid event', () => {
    const result = validateWebhookBody({ event: { type: 'create_pulse', pulseId: 42, boardId: 1 } });
    expect(result.donationItemId).toBe('42');
  });

  it('accepts a string pulseId too', () => {
    expect(validateWebhookBody({ event: { type: 'update_column_value', pulseId: '99' } }).donationItemId).toBe('99');
  });

  it('rejects a body with no event object', () => {
    expect(() => validateWebhookBody({})).toThrow(/no "event" object/);
  });

  it('rejects an event with no pulseId', () => {
    expect(() => validateWebhookBody({ event: { type: 'create_pulse' } })).toThrow(/pulseId/);
  });

  it('rejects a non-object body', () => {
    expect(() => validateWebhookBody(null)).toThrow();
    expect(() => validateWebhookBody('a string')).toThrow();
  });
});
