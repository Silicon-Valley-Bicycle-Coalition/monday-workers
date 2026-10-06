import { describe, it, expect } from 'vitest';
import { mapOrder, itemName } from './order';
import { testConfig, testOrder } from '../test/testConfig';

const config = testConfig({ thankYouSentColumn: 'tys_col', giftTypeColumn: 'gift_col', fiscalYearColumn: 'fy_col' });

describe('mapOrder', () => {
  it('maps a placed order: gross amount, Received, the Pacific day of `created`, the order id, and the first-write stamps', () => {
    const result = mapOrder(testOrder(), config, { hasItem: false });
    expect(result.outcome).toBe('write');
    if (result.outcome !== 'write') return;
    expect(result.itemName).toBe('Jane Rider - Bike Summit 2026');
    expect(result.columnValues).toEqual({
      amount_col: 45.32,
      status_col: 'Received',
      order_id_col: '442719216',
      // 2026-09-15T02:00:00Z is the evening of 2026-09-14 in California.
      date_col: { date: '2026-09-14' },
    });
    expect(result.firstWriteValues).toEqual({ tys_col: { checked: 'true' }, gift_col: 'Event Ticket', fy_col: '2027' });
    expect(result.facts).toEqual({ eventId: '17937020110', eventbriteStatus: 'placed', amount: '45.32', currency: 'USD', orderCreated: '2026-09-15T02:00:00Z' });
  });

  it('maps a refunded order to the Refunded label', () => {
    const result = mapOrder(testOrder({ status: 'refunded' }), config, { hasItem: true });
    expect(result.outcome).toBe('write');
    if (result.outcome !== 'write') return;
    expect(result.columnValues.status_col).toBe('Refunded');
  });

  it('uses base_price when amountSource says so', () => {
    const result = mapOrder(testOrder(), testConfig({ amountSource: 'base_price' }), { hasItem: false });
    expect(result.outcome).toBe('write');
    if (result.outcome !== 'write') return;
    expect(result.columnValues.amount_col).toBe(40);
    expect(result.facts.amount).toBe('40.00');
  });

  it.each(['started', 'pending', 'abandoned', 'unpaid'])('skips an order whose status (%s) is not a mapped label', (status) => {
    const result = mapOrder(testOrder({ status }), config, { hasItem: false });
    expect(result.outcome).toBe('skip');
    if (result.outcome !== 'skip') return;
    expect(result.reason).toContain(`"${status}"`);
    expect(result.facts.eventbriteStatus).toBe(status);
  });

  it('skips an order with no status', () => {
    const result = mapOrder(testOrder({ status: undefined }), config, { hasItem: false });
    expect(result.outcome).toBe('skip');
  });

  it('skips a free order that has no Donations item yet', () => {
    const free = testOrder({ costs: { gross: { currency: 'USD', value: 0, major_value: '0.00', display: '$0.00' } } });
    const result = mapOrder(free, config, { hasItem: false });
    expect(result.outcome).toBe('skip');
    if (result.outcome !== 'skip') return;
    expect(result.reason).toContain('free order');
  });

  it('skips an order with no costs at all as free', () => {
    const result = mapOrder(testOrder({ costs: undefined }), config, { hasItem: false });
    expect(result.outcome).toBe('skip');
  });

  it('still writes a zero-amount order that already has an item, so a refund is never masked', () => {
    const zero = testOrder({ status: 'refunded', costs: { gross: { currency: 'USD', value: 0, major_value: '0.00', display: '$0.00' } } });
    const result = mapOrder(zero, config, { hasItem: true });
    expect(result.outcome).toBe('write');
    if (result.outcome !== 'write') return;
    expect(result.columnValues.amount_col).toBe(0);
    expect(result.columnValues.status_col).toBe('Refunded');
  });

  it('writes a free order when skipFreeOrders is off', () => {
    const free = testOrder({ costs: { gross: { currency: 'USD', value: 0, major_value: '0.00', display: '$0.00' } } });
    expect(mapOrder(free, testConfig({ skipFreeOrders: false }), { hasItem: false }).outcome).toBe('write');
  });

  it('skips a major_value that is not a number rather than writing garbage', () => {
    const odd = testOrder({ costs: { gross: { currency: 'USD', value: 1, major_value: 'n/a', display: '' } } });
    expect(mapOrder(odd, config, { hasItem: false }).outcome).toBe('skip');
  });

  it('leaves the Date column and the fiscal-year stamp out when `created` is unparseable', () => {
    const result = mapOrder(testOrder({ created: 'yesterday' }), config, { hasItem: false });
    expect(result.outcome).toBe('write');
    if (result.outcome !== 'write') return;
    expect(result.columnValues).not.toHaveProperty('date_col');
    expect(result.firstWriteValues).not.toHaveProperty('fy_col');
  });

  it('omits each first-write stamp whose column is null', () => {
    const result = mapOrder(testOrder(), testConfig(), { hasItem: false });
    expect(result.outcome).toBe('write');
    if (result.outcome !== 'write') return;
    expect(result.firstWriteValues).toEqual({});
  });
});

describe('itemName', () => {
  it('fills the template from the buyer name and the expanded event name', () => {
    expect(itemName(testOrder(), '{event}: {buyer} ({orderId})')).toBe('Bike Summit 2026: Jane Rider (442719216)');
  });

  it('falls back to first/last name when `name` is missing', () => {
    expect(itemName(testOrder({ name: '' }), '{buyer} - {event}')).toBe('Jane Rider - Bike Summit 2026');
  });

  it('falls back to placeholders when the buyer or the event expansion is missing', () => {
    expect(itemName(testOrder({ name: null, first_name: null, last_name: null, event: undefined }), '{buyer} - {event}')).toBe('Unknown buyer - Eventbrite event');
  });

  it('never returns an empty name', () => {
    expect(itemName(testOrder(), '   ')).toBe('Eventbrite order 442719216');
  });
});
