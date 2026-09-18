import { describe, it, expect } from 'vitest';
import { validateEnvelope, extractEntityId } from './validate';
import { testConfig } from '../test/testConfig';

// Funraise's documented delivery shape (help.funraise.io "Webhooks"): an envelope with the
// send time, an event name, and the entity object under `data` — whose `id` is a number.
describe('validateEnvelope', () => {
  it('unwraps the entity from data and keys the delivery on the entity id plus sentAt', () => {
    const result = validateEnvelope({
      sentAt: 1599067884009,
      event: 'DONATION',
      data: { id: 123, description: 'Debbie Donor - Funraise' },
    });
    expect(result).toEqual({
      eventId: '123:1599067884009',
      sentAt: 1599067884009,
      raw: { id: 123, description: 'Debbie Donor - Funraise' },
    });
  });

  it('accepts a string entity id', () => {
    const result = validateEnvelope({ sentAt: 1, data: { id: 'txn-9' } });
    expect(result.eventId).toBe('txn-9:1');
    expect(result.sentAt).toBe(1);
    expect(result.raw).toEqual({ id: 'txn-9' });
  });

  it('falls back to the entity updtime, then to the bare id, when sentAt is absent', () => {
    const fromUpdtime = validateEnvelope({ data: { id: 123, updtime: 1599067883734 } });
    expect(fromUpdtime.eventId).toBe('123:1599067883734');
    expect(fromUpdtime.sentAt).toBe(1599067883734);

    const bare = validateEnvelope({ data: { id: 123 } });
    expect(bare.eventId).toBe('123');
    expect(bare.sentAt).toBeNull();
  });

  it('throws when the body is not an object', () => {
    expect(() => validateEnvelope('not-an-object')).toThrow(/must be a JSON object/);
  });

  it('throws when the body is null', () => {
    expect(() => validateEnvelope(null)).toThrow(/must be a JSON object/);
  });

  it('throws when the body has no data object — the pre-envelope bare shape is not accepted', () => {
    expect(() => validateEnvelope({ id: 'evt-1', amount: 100 })).toThrow(/missing a "data" object/);
    expect(() => validateEnvelope({ data: 'nope' })).toThrow(/missing a "data" object/);
  });

  it('throws when data.id is missing or empty', () => {
    expect(() => validateEnvelope({ data: { amount: 100 } })).toThrow(/missing a non-empty "data.id"/);
    expect(() => validateEnvelope({ data: { id: '' } })).toThrow(/missing a non-empty "data.id"/);
  });
});

describe('extractEntityId', () => {
  const config = testConfig({ entityIdField: 'transactionId' });

  it('reads the configured path from the payload', () => {
    const envelope = { eventId: 'evt-1', sentAt: null, raw: { id: 'evt-1', transactionId: 'txn-9' } };
    expect(extractEntityId(envelope, config)).toBe('txn-9');
  });

  it('stringifies a numeric entity id', () => {
    const envelope = { eventId: 'evt-1', sentAt: null, raw: { id: 'evt-1', transactionId: 42 } };
    expect(extractEntityId(envelope, config)).toBe('42');
  });

  it('falls back to the event id when the configured field is absent', () => {
    const envelope = { eventId: 'evt-7', sentAt: null, raw: { id: 'evt-7' } };
    expect(extractEntityId(envelope, config)).toBe('evt-7');
  });
});
