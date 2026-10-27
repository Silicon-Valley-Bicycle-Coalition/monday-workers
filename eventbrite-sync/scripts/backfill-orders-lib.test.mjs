import { describe, it, expect } from 'vitest';
import { listOrdersUrl, parseOrdersPage, planBackfill, readArg, checkTarget, sendDelivery, listAttendeesUrl, parseAttendeesPage, planAttendeeBackfill } from './backfill-orders-lib.mjs';
import { validateDelivery } from '../src/webhook/validate';
import { validateAttendeeDelivery } from '../src/webhook/validateAttendee';
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

describe('readArg', () => {
  it('returns the default when the flag is absent and the value when present', () => {
    expect(readArg(['--event-id', '1'], '--env', null)).toBeNull();
    expect(readArg(['--env', 'sandbox'], '--env', null)).toBe('sandbox');
  });

  it('refuses a missing value or one that is itself a flag', () => {
    expect(() => readArg(['--env', '--dry-run'], '--env', null)).toThrow('--env needs a value');
    expect(() => readArg(['--env'], '--env', null)).toThrow('--env needs a value');
  });
});

describe('checkTarget', () => {
  it('accepts matching environments and a dry run with no Worker', () => {
    expect(() => checkTarget('sandbox', 'https://svbc-eventbrite-sync-sandbox.x.workers.dev')).not.toThrow();
    expect(() => checkTarget(null, 'https://svbc-eventbrite-sync.x.workers.dev')).not.toThrow();
    expect(() => checkTarget('sandbox', null)).not.toThrow();
  });

  it('refuses a sandbox run at a production Worker and the reverse', () => {
    expect(() => checkTarget('sandbox', 'https://svbc-eventbrite-sync.x.workers.dev')).toThrow('not a -sandbox Worker');
    expect(() => checkTarget(null, 'https://svbc-eventbrite-sync-sandbox.x.workers.dev')).toThrow('pass --env sandbox');
  });
});

describe('sendDelivery', () => {
  const noSleep = () => Promise.resolve();
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => body });

  it('succeeds on an enqueued delivery without retrying', async () => {
    const calls = [];
    const fetchFn = async (...a) => (calls.push(a), reply(200, '{"ok":true}'));
    expect(await sendDelivery(fetchFn, 'u', 's', { a: 1 }, { sleep: noSleep })).toMatchObject({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
  });

  it('retries a network error, a 429 and a 5xx, then succeeds', async () => {
    const queue = [() => { throw new Error('boom'); }, () => reply(429, 'slow'), () => reply(502, 'bad'), () => reply(200, '{"ok":true}')];
    const fetchFn = async () => queue.shift()();
    expect(await sendDelivery(fetchFn, 'u', 's', {}, { attempts: 4, sleep: noSleep })).toMatchObject({ ok: true });
  });

  it('gives up after the attempts and reports the last failure', async () => {
    const fetchFn = async () => reply(503, 'down');
    expect(await sendDelivery(fetchFn, 'u', 's', {}, { attempts: 2, sleep: noSleep })).toEqual({ ok: false, status: 503, body: 'down' });
  });

  it('does not retry a 4xx, and an ignored delivery is not a success', async () => {
    let n = 0;
    expect((await sendDelivery(async () => (n++, reply(401, 'no')), 'u', 's', {}, { sleep: noSleep })).ok).toBe(false);
    expect(n).toBe(1);
    expect((await sendDelivery(async () => reply(200, '{"ok":true,"ignored":"x"}'), 'u', 's', {}, { sleep: noSleep })).ok).toBe(false);
  });
});

describe('listAttendeesUrl', () => {
  it('lists an event’s attendees, with the continuation token when paging', () => {
    expect(listAttendeesUrl(API, '17937020110')).toBe('https://www.eventbriteapi.com/v3/events/17937020110/attendees/');
    expect(listAttendeesUrl(API, '17937020110', { continuation: 'abc' })).toBe(
      'https://www.eventbriteapi.com/v3/events/17937020110/attendees/?continuation=abc'
    );
  });

  it('refuses a non-numeric event id', () => {
    expect(() => listAttendeesUrl(API, '../users/me')).toThrow('must be numeric');
  });
});

describe('parseAttendeesPage', () => {
  it('returns attendee ids and the continuation token while has_more_items is true', () => {
    const page = parseAttendeesPage({ pagination: { has_more_items: true, continuation: 'tok' }, attendees: [{ id: '1', profile: { email: 'x@y.z' } }] });
    expect(page).toEqual({ attendees: [{ id: '1' }], continuation: 'tok' });
  });

  it('ends paging when has_more_items is false, whatever the token says', () => {
    expect(parseAttendeesPage({ pagination: { has_more_items: false, continuation: 'tok' }, attendees: [] }).continuation).toBeNull();
    expect(parseAttendeesPage({ attendees: [] }).continuation).toBeNull();
  });

  it('throws on a response without an attendees array', () => {
    expect(() => parseAttendeesPage({ error: 'NOT_AUTHORIZED' })).toThrow('no "attendees" array');
  });
});

describe('planAttendeeBackfill', () => {
  const plan = planAttendeeBackfill([{ id: '30' }, { id: '4' }, { id: 'x' }], { apiUrl: API, eventId: '17937020110' });

  it('puts the event delivery first, then attendees sorted by id, skipping non-numeric ids', () => {
    expect(plan.deliveries.map((d) => d.label)).toEqual(['event 17937020110', 'attendee 4', 'attendee 30']);
    expect(plan.skipped).toEqual([{ attendeeId: 'x', reason: 'no numeric id' }]);
  });

  it('builds deliveries the attendee route accepts, ids only', () => {
    const config = testConfig();
    const verdicts = plan.deliveries.map((d) => validateAttendeeDelivery(d.delivery, config));
    expect(verdicts).toEqual([
      { kind: 'process', delivery: { kind: 'event', eventId: '17937020110', action: 'event.updated' } },
      { kind: 'process', delivery: { kind: 'attendee', eventId: '17937020110', attendeeId: '4', action: 'attendee.updated' } },
      { kind: 'process', delivery: { kind: 'attendee', eventId: '17937020110', attendeeId: '30', action: 'attendee.updated' } },
    ]);
  });
});
