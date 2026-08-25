import { describe, it, expect } from 'vitest';
import { validateLetterWebhookBody } from './validateLetterWebhook';

describe('validateLetterWebhookBody', () => {
  it('extracts the donor item id from a numeric pulseId', () => {
    expect(validateLetterWebhookBody({ event: { type: 'update_column_value', pulseId: 555, boardId: 18427756119 } })).toEqual({
      donorItemId: '555',
    });
  });

  it('extracts the donor item id from a string pulseId', () => {
    expect(validateLetterWebhookBody({ event: { pulseId: '555' } })).toEqual({ donorItemId: '555' });
  });

  it('throws when the body is not an object', () => {
    expect(() => validateLetterWebhookBody('nope')).toThrow('webhook body is not an object');
  });

  it('throws when there is no event object', () => {
    expect(() => validateLetterWebhookBody({})).toThrow('webhook body has no "event" object');
  });

  it('throws when the event has no pulseId', () => {
    expect(() => validateLetterWebhookBody({ event: { type: 'update_column_value' } })).toThrow('webhook event has no pulseId');
  });
});
