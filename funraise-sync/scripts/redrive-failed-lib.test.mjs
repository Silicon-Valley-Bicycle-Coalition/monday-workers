import { describe, it, expect } from 'vitest';
import { planRedrive, selectFailedSql } from './redrive-failed-lib.mjs';
import { validateEnvelope } from '../src/webhook/validate';

const row = (over = {}) => ({
  entity_id: '123',
  sent_at: 1790000000000,
  raw_payload: JSON.stringify({ id: 123, transaction: { status: 'Refunded', amount: 10 } }),
  status: 'failed',
  error: 'dead-lettered after retries: boom',
  received_at: '2026-09-20T00:00:00.000Z',
  ...over,
});

describe('planRedrive', () => {
  it('rebuilds the original envelope so the route derives the same event_id', () => {
    const { deliveries } = planRedrive([row()]);
    expect(deliveries).toHaveLength(1);
    const validated = validateEnvelope(deliveries[0].envelope);
    expect(validated.eventId).toBe('123:1790000000000');
    expect(validated.raw).toEqual({ id: 123, transaction: { status: 'Refunded', amount: 10 } });
  });

  it('omits sentAt when the row has none, matching how the route keyed it', () => {
    const { deliveries } = planRedrive([row({ sent_at: null })]);
    expect('sentAt' in deliveries[0].envelope).toBe(false);
    expect(validateEnvelope(deliveries[0].envelope).eventId).toBe('123');
  });

  it('reports rows whose payload the retention purge emptied instead of replaying them', () => {
    const { deliveries, unreplayable } = planRedrive([row({ raw_payload: '{}' }), row({ entity_id: '9', raw_payload: 'not json' })]);
    expect(deliveries).toHaveLength(0);
    expect(unreplayable.map((u) => u.entityId)).toEqual(['123', '9']);
  });

  it('orders by received_at then entity id', () => {
    const { deliveries } = planRedrive([
      row({ entity_id: 'b', received_at: '2026-09-21T00:00:00.000Z' }),
      row({ entity_id: 'c', received_at: '2026-09-20T00:00:00.000Z' }),
      row({ entity_id: 'a', received_at: '2026-09-21T00:00:00.000Z' }),
    ]);
    expect(deliveries.map((d) => d.entityId)).toEqual(['c', 'a', 'b']);
  });
});

describe('selectFailedSql', () => {
  it('selects the given statuses older than the cutoff', () => {
    const sql = selectFailedSql(['failed'], '2026-09-25T00:00:00.000Z');
    expect(sql).toContain(`status IN ('failed')`);
    expect(sql).toContain(`received_at < '2026-09-25T00:00:00.000Z'`);
  });

  it('refuses anything that is not a known status or an ISO cutoff', () => {
    expect(() => selectFailedSql(["failed'; DROP TABLE events; --"], '2026-09-25T00:00:00.000Z')).toThrow();
    expect(() => selectFailedSql(['failed'], "x' OR 1=1")).toThrow();
  });
});
