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

describe('validateEnvelope', () => {
  it('returns the event id, entity type, and raw payload when valid', () => {
    const result = validateEnvelope('transaction', { id: 'evt-1', amount: 100 });
    expect(result).toEqual({ eventId: 'evt-1', entityType: 'transaction', raw: { id: 'evt-1', amount: 100 } });
  });

  it('throws on an unknown entity type', () => {
    expect(() => validateEnvelope('donation', { id: 'evt-1' })).toThrow(/unknown entity type "donation"/);
  });

  it('throws when the body is not an object', () => {
    expect(() => validateEnvelope('transaction', 'not-an-object')).toThrow(/must be a JSON object/);
  });

  it('throws when the body is null', () => {
    expect(() => validateEnvelope('transaction', null)).toThrow(/must be a JSON object/);
  });

  it('throws when id is missing', () => {
    expect(() => validateEnvelope('transaction', { amount: 100 })).toThrow(/missing a non-empty "id"/);
  });

  it('throws when id is an empty string', () => {
    expect(() => validateEnvelope('transaction', { id: '' })).toThrow(/missing a non-empty "id"/);
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
