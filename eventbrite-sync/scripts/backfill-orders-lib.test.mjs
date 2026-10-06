import { describe, it, expect } from 'vitest';
import { listOrdersUrl, parseOrdersPage, planBackfill } from './backfill-orders-lib.mjs';
import { validateDelivery } from '../src/webhook/validate';
import { testConfig } from '../src/test/testConfig';

const API = 'https://www.eventbriteapi.com/v3';

describe('listOrdersUrl', () => {
  it('lists an event’s non-deleted orders, with the continuation token when paging', () => {
    expect(listOrdersUrl(API, '17937020110')).toBe('https://www.eventbriteapi.com/v3/events/17937020110/orders/?status=all_not_deleted');
    expect(listOrdersUrl(API, '17937020110', { continuation: 'abc', changedSince: '2026-10-09T00:00:00Z' })).toBe(
      'https://www.eventbriteapi.com/v3/events/17937020110/orders/?status=all_not_deleted&changed_since=2026-10-09T00%3A00%3A00Z&continuation=abc'
    );
  });

  it('refuses a non-numeric event id', () => {
    expect(() => listOrdersUrl(API, '../users/me')).toThrow('must be numeric');
  });
});

describe('parseOrdersPage', () => {
  it('returns the orders and the continuation token while there are more pages', () => {
    const page = parseOrdersPage({ pagination: { has_more_items: true, continuation: 'tok' }, orders: [{ id: '1' }] });
    expect(page).toEqual({ orders: [{ id: '1' }], continuation: 'tok' });
  });

  it('ends paging when has_more_items is false, whatever the token says', () => {
    expect(parseOrdersPage({ pagination: { has_more_items: false, continuation: 'tok' }, orders: [] }).continuation).toBeNull();
    expect(parseOrdersPage({ orders: [] }).continuation).toBeNull();
  });

  it('throws on a response without an orders array', () => {
    expect(() => parseOrdersPage({ error: 'NOT_AUTHORIZED' })).toThrow('no "orders" array');
  });
});

describe('planBackfill', () => {
  const orders = [
    { id: '30', status: 'placed', resource_uri: 'https://www.eventbriteapi.com/v3/orders/30/' },
    { id: '4', status: 'refunded' },
    { id: '5', status: 'pending' },
    { id: '6', status: 'abandoned' },
    { status: 'placed' },
  ];

  it('turns placed and refunded orders into deliveries the route accepts, in id order, and reports the rest', () => {
    const { deliveries, skipped } = planBackfill(orders, { apiUrl: API });
    expect(deliveries.map((d) => d.orderId)).toEqual(['4', '30']);
    expect(deliveries[0].delivery).toEqual({
      api_url: 'https://www.eventbriteapi.com/v3/orders/4/',
      config: { action: 'order.refunded', endpoint_url: 'scripts/backfill-orders.mjs' },
    });
    expect(deliveries[1].delivery.config.action).toBe('order.placed');
    expect(skipped).toEqual([
      { orderId: '5', reason: 'status "pending"' },
      { orderId: '6', reason: 'status "abandoned"' },
      { orderId: '(no id)', reason: 'no numeric id' },
    ]);
  });

  it('builds deliveries the route validates to the same order id (no user_id, so the organization check passes)', () => {
    const { deliveries } = planBackfill(orders, { apiUrl: API });
    const config = testConfig({}, {}, { organizationId: '308733706151' });
    for (const d of deliveries) {
      const verdict = validateDelivery(d.delivery, config);
      expect(verdict).toEqual({ kind: 'process', delivery: { orderId: d.orderId, action: d.delivery.config.action, organizationId: null } });
    }
  });

  it('builds api_url from the configured base, never from resource_uri', () => {
    const { deliveries } = planBackfill([{ id: '9', status: 'placed', resource_uri: 'https://evil.example/v3/orders/9/' }], { apiUrl: API });
    expect(deliveries[0].delivery.api_url).toBe('https://www.eventbriteapi.com/v3/orders/9/');
  });
});
