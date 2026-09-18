import { describe, it, expect } from 'vitest';
import { validateEnvelope, isEntityType, extractEntityId } from './validate';

describe('isEntityType', () => {
  it('accepts the four known entity types', () => {
    expect(isEntityType('transaction')).toBe(true);
    expect(isEntityType('subscription')).toBe(true);
    expect(isEntityType('pledge')).toBe(true);
    expect(isEntityType('registration')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isEntityType('donation')).toBe(false);
  });
});

// Funraise's documented delivery shape (help.funraise.io "Webhooks"): an envelope with the
// send time, an event name, and the entity object under `data` — whose `id` is a number.
describe('validateEnvelope', () => {
  it('unwraps the entity from data and keys the delivery on the entity id plus sentAt', () => {
    const result = validateEnvelope('transaction', {
      sentAt: 1599067884009,
      event: 'DONATION',
      data: { id: 123, description: 'Debbie Donor - Funraise' },
    });
    expect(result).toEqual({
      eventId: '123:1599067884009',
      entityType: 'transaction',
      raw: { id: 123, description: 'Debbie Donor - Funraise' },
    });
  });

  it('accepts a string entity id', () => {
    const result = validateEnvelope('transaction', { sentAt: 1, data: { id: 'txn-9' } });
    expect(result.eventId).toBe('txn-9:1');
    expect(result.raw).toEqual({ id: 'txn-9' });
  });

  it('falls back to the entity updtime, then to the bare id, when sentAt is absent', () => {
    expect(validateEnvelope('transaction', { data: { id: 123, updtime: 1599067883734 } }).eventId).toBe(
      '123:1599067883734'
    );
    expect(validateEnvelope('transaction', { data: { id: 123 } }).eventId).toBe('123');
  });

  it('throws on an unknown entity type', () => {
    expect(() => validateEnvelope('donation', { data: { id: 1 } })).toThrow(/unknown entity type "donation"/);
  });

  it('throws when the body is not an object', () => {
    expect(() => validateEnvelope('transaction', 'not-an-object')).toThrow(/must be a JSON object/);
  });

  it('throws when the body is null', () => {
    expect(() => validateEnvelope('transaction', null)).toThrow(/must be a JSON object/);
  });

  it('throws when the body has no data object — the pre-envelope bare shape is not accepted', () => {
    expect(() => validateEnvelope('transaction', { id: 'evt-1', amount: 100 })).toThrow(/missing a "data" object/);
    expect(() => validateEnvelope('transaction', { data: 'nope' })).toThrow(/missing a "data" object/);
  });

  it('throws when data.id is missing or empty', () => {
    expect(() => validateEnvelope('transaction', { data: { amount: 100 } })).toThrow(/missing a non-empty "data.id"/);
    expect(() => validateEnvelope('transaction', { data: { id: '' } })).toThrow(/missing a non-empty "data.id"/);
  });
});

describe('extractEntityId', () => {
  const config = {
    funraiseSync: {
      entityIdField: { transaction: 'transactionId', recurringGift: 'subscriptionId', registration: 'id' },
    },
  } as unknown as import('../types').FunraiseSyncConfig;

  it('reads the configured per-entity path from the payload', () => {
    const envelope = { eventId: 'evt-1', entityType: 'transaction' as const, raw: { id: 'evt-1', transactionId: 'txn-9' } };
    expect(extractEntityId(envelope, config)).toBe('txn-9');
  });

  it('resolves subscription and pledge through the recurringGift mapping', () => {
    const envelope = { eventId: 'evt-1', entityType: 'pledge' as const, raw: { id: 'evt-1', subscriptionId: 'sub-3' } };
    expect(extractEntityId(envelope, config)).toBe('sub-3');
  });

  it('stringifies a numeric entity id', () => {
    const envelope = { eventId: 'evt-1', entityType: 'transaction' as const, raw: { id: 'evt-1', transactionId: 42 } };
    expect(extractEntityId(envelope, config)).toBe('42');
  });

  it('falls back to the event id when the configured field is absent', () => {
    const envelope = { eventId: 'evt-7', entityType: 'transaction' as const, raw: { id: 'evt-7' } };
    expect(extractEntityId(envelope, config)).toBe('evt-7');
  });
});
