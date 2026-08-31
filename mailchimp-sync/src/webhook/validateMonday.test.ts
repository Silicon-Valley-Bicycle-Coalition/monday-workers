import { describe, it, expect } from 'vitest';
import { validateMondayWebhookBody } from './validateMonday';

describe('validateMondayWebhookBody', () => {
  it('extracts the donor item id from a valid event', () => {
    expect(validateMondayWebhookBody({ event: { type: 'update_column_value', pulseId: 555, boardId: 123 } }))
      .toEqual({ donorItemId: '555', columnId: undefined });
  });

  it('accepts a numeric or string pulseId', () => {
    expect(validateMondayWebhookBody({ event: { pulseId: '555' } })).toEqual({ donorItemId: '555', columnId: undefined });
  });

  it('extracts columnId when present on a column-change event', () => {
    expect(validateMondayWebhookBody({ event: { type: 'update_column_value', pulseId: 555, boardId: 123, columnId: 'mc' } }))
      .toEqual({ donorItemId: '555', columnId: 'mc' });
  });

  it('leaves columnId undefined for a create_pulse event (no columnId at all)', () => {
    expect(validateMondayWebhookBody({ event: { type: 'create_pulse', pulseId: 555, boardId: 123 } }))
      .toEqual({ donorItemId: '555', columnId: undefined });
  });

  it('rejects a body with no event object', () => {
    expect(() => validateMondayWebhookBody({})).toThrow('webhook body has no "event" object');
  });

  it('rejects an event with no pulseId', () => {
    expect(() => validateMondayWebhookBody({ event: { type: 'create_pulse' } })).toThrow('webhook event has no pulseId');
  });

  it('rejects a non-object body', () => {
    expect(() => validateMondayWebhookBody('nope')).toThrow('webhook body is not an object');
  });
});
