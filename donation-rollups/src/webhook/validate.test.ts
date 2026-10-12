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

  // Monday's item_deleted payload (type delete_pulse) carries itemId, not pulseId — verified on
  // the CRM Sandbox 2026-10-12, where every deletion had been rejected as "no pulseId" since
  // the subscription was created. restore_pulse is shaped the same way.
  it('accepts itemId in place of pulseId, as delete_pulse and restore_pulse send it', () => {
    const deleted = validateWebhookBody({ event: { type: 'delete_pulse', itemId: 13269289918, boardId: 18431577302, itemName: 'x' } });
    expect(deleted.donationItemId).toBe('13269289918');
    expect(deleted.boardId).toBe('18431577302');
    expect(deleted.columnId).toBeNull();
    expect(deleted.eventId).toMatch(/^13269289918:delete_pulse:/);
    expect(validateWebhookBody({ event: { type: 'restore_pulse', itemId: '7', boardId: 1 } }).donationItemId).toBe('7');
  });

  it('prefers pulseId when both are present', () => {
    expect(validateWebhookBody({ event: { type: 'update_column_value', pulseId: 5, itemId: 6, boardId: 1 } }).donationItemId).toBe('5');
  });

  it('rejects an event with neither pulseId nor itemId', () => {
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
