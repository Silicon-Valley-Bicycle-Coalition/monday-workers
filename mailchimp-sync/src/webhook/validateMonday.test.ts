import { describe, it, expect } from 'vitest';
import { validateMondayWebhookBody } from './validateMonday';

describe('validateMondayWebhookBody', () => {
  it('extracts the donor item id from a valid event', () => {
    expect(validateMondayWebhookBody({ event: { type: 'update_column_value', pulseId: 555, boardId: 123 } }))
      .toMatchObject({ donorItemId: '555', columnId: undefined, boardId: 123 });
  });

  it('accepts a numeric or string pulseId', () => {
    expect(validateMondayWebhookBody({ event: { pulseId: '555' } })).toEqual({ donorItemId: '555', columnId: undefined, boardId: undefined });
  });

  it('extracts columnId when present on a column-change event', () => {
    expect(validateMondayWebhookBody({ event: { type: 'update_column_value', pulseId: 555, boardId: 123, columnId: 'mc' } }))
      .toMatchObject({ donorItemId: '555', columnId: 'mc', boardId: 123 });
  });

  it('leaves columnId undefined for a create_pulse event (no columnId at all)', () => {
    expect(validateMondayWebhookBody({ event: { type: 'create_pulse', pulseId: 555, boardId: 123 } }))
      .toMatchObject({ donorItemId: '555', columnId: undefined, boardId: 123 });
  });

  it('extracts the previous address from an email column change', () => {
    const body = { event: { type: 'update_column_value', pulseId: 555, columnId: 'e',
      value: { email: 'new@b.com', text: 'new@b.com' }, previousValue: { email: 'Old@B.com ', text: 'Old@B.com', changed_at: '2026-11-02T17:31:52Z' } } };
    expect(validateMondayWebhookBody(body)).toEqual({ donorItemId: '555', columnId: 'e', previousEmail: 'Old@B.com' });
  });

  it('leaves previousEmail undefined when there was no previous address or it is not an email value', () => {
    for (const previousValue of [null, undefined, {}, { email: '' }, { label: { text: 'Active' } }, 'x']) {
      expect(validateMondayWebhookBody({ event: { pulseId: 555, columnId: 'e', previousValue } }).previousEmail).toBeUndefined();
    }
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
