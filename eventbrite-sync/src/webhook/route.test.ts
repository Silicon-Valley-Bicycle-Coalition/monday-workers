import { describe, it, expect, vi } from 'vitest';
import { fakeEventStore, fakeAttendeeStore } from '../test/fakeStores';
import { createApp, secretsMatch } from './route';
import type { OrderStore } from '../db/orders';
import { testConfig } from '../test/testConfig';

const config = testConfig();

function fakeOrderStore(overrides: Partial<OrderStore> = {}): OrderStore {
  return {
    recordDelivery: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getOrder: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const SECRET = 'test-secret';

const delivery = (action = 'order.placed', orderId = '442719216') => ({
  api_url: `https://www.eventbriteapi.com/v3/orders/${orderId}/`,
  config: { action, user_id: '308733706151', webhook_id: '2006536', endpoint_url: 'https://x.example/webhooks/eventbrite/order' },
});

function post(app: ReturnType<typeof createApp>, body: unknown, query = `?secret=${SECRET}`, headers: Record<string, string> = {}) {
  return app.request(`/webhooks/eventbrite/order${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('createApp', () => {
  it('responds to GET /health with ok: true, unauthenticated', async () => {
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore: fakeOrderStore(), config, queue: { send: vi.fn() }, webhookSecret: SECRET, writeMode: async () => 'on' });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('records the delivery by order id, enqueues it, and marks it queued', async () => {
    const orderStore = fakeOrderStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });

    const res = await post(app, delivery());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(orderStore.recordDelivery).toHaveBeenCalledWith({ orderId: '442719216', action: 'order.placed', receivedAt: expect.any(String) });
    expect(send).toHaveBeenCalledWith({ orderId: '442719216', action: 'order.placed' });
    expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'queued');
  });

  it('records the order row before enqueueing', async () => {
    const orderStore = fakeOrderStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
    await post(app, delivery());
    expect(vi.mocked(orderStore.recordDelivery).mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[0]!);
  });

  it('enqueues a redelivery of a known order too — the consumer re-fetches and writes idempotently', async () => {
    const orderStore = fakeOrderStore({ recordDelivery: vi.fn().mockResolvedValue('updated') });
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });

    const res = await post(app, delivery('order.refunded'));

    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith({ orderId: '442719216', action: 'order.refunded' });
  });

  it('acknowledges and ignores an unsubscribed action without touching the store', async () => {
    const orderStore = fakeOrderStore();
    const send = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
      const res = await post(app, delivery('event.updated'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, ignored: 'action "event.updated" is not subscribed' });
      expect(orderStore.recordDelivery).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ignored delivery'));
    } finally {
      warn.mockRestore();
    }
  });

  it('answers 200 with ok: false and logs when the payload is malformed, so Eventbrite does not retry it', async () => {
    const orderStore = fakeOrderStore();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send: vi.fn() }, webhookSecret: SECRET, writeMode: async () => 'on' });
      const res = await post(app, { api_url: 'https://evil.example/v3/orders/1/', config: { action: 'order.placed' } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: false, error: expect.stringContaining('not an order URL') });
      expect(orderStore.recordDelivery).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('rejected delivery'));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('answers 200 with ok: false on a body that is not JSON', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore: fakeOrderStore(), config, queue: { send: vi.fn() }, webhookSecret: SECRET, writeMode: async () => 'on' });
      const res = await app.request(`/webhooks/eventbrite/order?secret=${SECRET}`, { method: 'POST', body: 'not json' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns 500 and marks the row failed when the enqueue fails, so Eventbrite redelivers', async () => {
    const orderStore = fakeOrderStore();
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
      const res = await post(app, delivery());
      expect(res.status).toBe(500);
      expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'failed', { error: 'queue unavailable' });
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('404s any other path', async () => {
    const orderStore = fakeOrderStore();
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send: vi.fn() }, webhookSecret: SECRET, writeMode: async () => 'on' });
    const res = await app.request(`/webhooks/eventbrite/unknown?secret=${SECRET}`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
    expect(orderStore.recordDelivery).not.toHaveBeenCalled();
  });
});

describe('webhook authentication', () => {
  it('rejects a POST without the shared secret with 401, before touching the store', async () => {
    const orderStore = fakeOrderStore();
    const send = vi.fn();
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
    const res = await post(app, delivery(), '');
    expect(res.status).toBe(401);
    expect(orderStore.recordDelivery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret, and a secret that is only a prefix of the real one', async () => {
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore: fakeOrderStore(), config, queue: { send: vi.fn() }, webhookSecret: SECRET, writeMode: async () => 'on' });
    expect((await post(app, delivery(), '?secret=wrong')).status).toBe(401);
    expect((await post(app, delivery(), '?secret=test')).status).toBe(401);
  });

  it('fails closed with 401 when no secret is configured, even if the request carries one', async () => {
    const orderStore = fakeOrderStore();
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send: vi.fn() }, webhookSecret: undefined, writeMode: async () => 'on' });
    const res = await post(app, delivery());
    expect(res.status).toBe(401);
    expect(orderStore.recordDelivery).not.toHaveBeenCalled();
  });

  it('accepts the secret in the X-Webhook-Secret header with no query param (the backfill script)', async () => {
    const orderStore = fakeOrderStore();
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send: vi.fn().mockResolvedValue(undefined) }, webhookSecret: SECRET, writeMode: async () => 'on' });
    const res = await post(app, delivery(), '', { 'X-Webhook-Secret': SECRET });
    expect(res.status).toBe(200);
    expect(orderStore.recordDelivery).toHaveBeenCalled();
  });

  it('rejects a wrong header secret with 401', async () => {
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore: fakeOrderStore(), config, queue: { send: vi.fn() }, webhookSecret: SECRET, writeMode: async () => 'on' });
    const res = await post(app, delivery(), '', { 'X-Webhook-Secret': 'test-secreT' });
    expect(res.status).toBe(401);
  });
});

describe('write switch', () => {
  it.each([
    ['off', { orderId: '442719216', action: 'order.placed', writeStamp: 'dropped' }],
    ['on', { orderId: '442719216', action: 'order.placed' }],
    ['hold', { orderId: '442719216', action: 'order.placed' }],
  ] as const)('under %s still records the delivery and enqueues, stamping only under off', async (mode, expected) => {
    const orderStore = fakeOrderStore();
    const send = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ eventStore: fakeEventStore(), attendeeStore: fakeAttendeeStore(), orderStore, config, queue: { send }, webhookSecret: SECRET, writeMode: async () => mode });

    const res = await post(app, delivery());

    expect(res.status).toBe(200);
    expect(orderStore.recordDelivery).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expected);
    expect(orderStore.updateStatus).toHaveBeenCalledWith('442719216', 'queued');
  });
});

describe('secretsMatch', () => {
  it('matches equal strings and rejects different or differently sized ones', async () => {
    expect(await secretsMatch('abc', 'abc')).toBe(true);
    expect(await secretsMatch('abc', 'abd')).toBe(false);
    expect(await secretsMatch('abc', 'abcd')).toBe(false);
    expect(await secretsMatch('', 'abc')).toBe(false);
  });

  it('never matches when either side is missing', async () => {
    expect(await secretsMatch(undefined, 'abc')).toBe(false);
    expect(await secretsMatch('abc', undefined)).toBe(false);
    expect(await secretsMatch('abc', '')).toBe(false);
  });

  describe('POST /webhooks/eventbrite/attendee', () => {
    const attendeeDelivery = (action = 'attendee.updated', path = '/events/1001/attendees/2002/') => ({
      api_url: `https://www.eventbriteapi.com/v3${path}`,
      config: { action, user_id: '308733706151', webhook_id: '2006537', endpoint_url: 'https://x.example/webhooks/eventbrite/attendee' },
    });
    const postAttendee = (app: ReturnType<typeof createApp>, body: unknown, query = `?secret=${SECRET}`) =>
      app.request(`/webhooks/eventbrite/attendee${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    it('returns 401 without the secret and touches nothing', async () => {
      const attendeeStore = fakeAttendeeStore();
      const send = vi.fn();
      const app = createApp({ eventStore: fakeEventStore(), attendeeStore, orderStore: fakeOrderStore(), config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
      const res = await postAttendee(app, attendeeDelivery(), '');
      expect(res.status).toBe(401);
      expect(attendeeStore.recordDelivery).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('records an attendees row, enqueues an attendee message, and marks it queued', async () => {
      const attendeeStore = fakeAttendeeStore();
      const send = vi.fn().mockResolvedValue(undefined);
      const app = createApp({ eventStore: fakeEventStore(), attendeeStore, orderStore: fakeOrderStore(), config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
      const res = await postAttendee(app, attendeeDelivery());
      expect(res.status).toBe(200);
      expect(attendeeStore.recordDelivery).toHaveBeenCalledWith({ attendeeId: '2002', eventId: '1001', action: 'attendee.updated', receivedAt: expect.any(String) });
      expect(send).toHaveBeenCalledWith({ kind: 'attendee', eventId: '1001', attendeeId: '2002', action: 'attendee.updated' });
      expect(attendeeStore.updateStatus).toHaveBeenCalledWith('2002', 'queued');
    });

    it('records an events row and enqueues an event message for an event URL', async () => {
      const eventStore = fakeEventStore();
      const attendeeStore = fakeAttendeeStore();
      const send = vi.fn().mockResolvedValue(undefined);
      const app = createApp({ eventStore, attendeeStore, orderStore: fakeOrderStore(), config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
      const res = await postAttendee(app, attendeeDelivery('event.published', '/events/1001/'));
      expect(res.status).toBe(200);
      expect(eventStore.recordDelivery).toHaveBeenCalledWith({ eventId: '1001', action: 'event.published', receivedAt: expect.any(String) });
      expect(send).toHaveBeenCalledWith({ kind: 'event', eventId: '1001', action: 'event.published' });
      expect(eventStore.updateStatus).toHaveBeenCalledWith('1001', 'queued');
      expect(attendeeStore.recordDelivery).not.toHaveBeenCalled();
    });

    it.each([
      ['off', { writeStamp: 'dropped' }],
      ['hold', {}],
      ['on', {}],
    ] as const)('under %s records and enqueues event and attendee messages, stamping only under off', async (mode, stamp) => {
      const eventStore = fakeEventStore();
      const attendeeStore = fakeAttendeeStore();
      const send = vi.fn().mockResolvedValue(undefined);
      const app = createApp({ eventStore, attendeeStore, orderStore: fakeOrderStore(), config, queue: { send }, webhookSecret: SECRET, writeMode: async () => mode });
      expect((await postAttendee(app, attendeeDelivery())).status).toBe(200);
      expect((await postAttendee(app, attendeeDelivery('event.published', '/events/1001/'))).status).toBe(200);
      expect(attendeeStore.recordDelivery).toHaveBeenCalled();
      expect(eventStore.recordDelivery).toHaveBeenCalled();
      expect(send).toHaveBeenNthCalledWith(1, { kind: 'attendee', eventId: '1001', attendeeId: '2002', action: 'attendee.updated', ...stamp });
      expect(send).toHaveBeenNthCalledWith(2, { kind: 'event', eventId: '1001', action: 'event.published', ...stamp });
    });

    it('records the ledger row before enqueueing', async () => {
      const attendeeStore = fakeAttendeeStore();
      const send = vi.fn().mockResolvedValue(undefined);
      const app = createApp({ eventStore: fakeEventStore(), attendeeStore, orderStore: fakeOrderStore(), config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
      await postAttendee(app, attendeeDelivery());
      expect(vi.mocked(attendeeStore.recordDelivery).mock.invocationCallOrder[0]!).toBeLessThan(send.mock.invocationCallOrder[0]!);
    });

    it('marks the attendee row failed and returns 500 when the enqueue fails', async () => {
      const attendeeStore = fakeAttendeeStore();
      const send = vi.fn().mockRejectedValue(new Error('queue down'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const app = createApp({ eventStore: fakeEventStore(), attendeeStore, orderStore: fakeOrderStore(), config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
        const res = await postAttendee(app, attendeeDelivery());
        expect(res.status).toBe(500);
        expect(attendeeStore.updateStatus).toHaveBeenCalledWith('2002', 'failed', { error: 'queue down' });
        expect(attendeeStore.updateStatus).not.toHaveBeenCalledWith('2002', 'queued');
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('marks the event row failed and returns 500 when the enqueue fails for an event', async () => {
      const eventStore = fakeEventStore();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const app = createApp({ eventStore, attendeeStore: fakeAttendeeStore(), orderStore: fakeOrderStore(), config, queue: { send: vi.fn().mockRejectedValue(new Error('queue down')) }, webhookSecret: SECRET, writeMode: async () => 'on' });
        const res = await postAttendee(app, attendeeDelivery('event.updated', '/events/1001/'));
        expect(res.status).toBe(500);
        expect(eventStore.updateStatus).toHaveBeenCalledWith('1001', 'failed', { error: 'queue down' });
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('answers 200 and records nothing for an order URL or an order action', async () => {
      const attendeeStore = fakeAttendeeStore();
      const send = vi.fn();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const app = createApp({ eventStore: fakeEventStore(), attendeeStore, orderStore: fakeOrderStore(), config, queue: { send }, webhookSecret: SECRET, writeMode: async () => 'on' });
        const wrongUrl = await postAttendee(app, attendeeDelivery('attendee.updated', '/orders/442719216/'));
        expect(wrongUrl.status).toBe(200);
        expect((await wrongUrl.json() as { ok: boolean }).ok).toBe(false);
        const wrongAction = await postAttendee(app, attendeeDelivery('order.placed'));
        expect(await wrongAction.json()).toEqual({ ok: true, ignored: 'action "order.placed" is not subscribed' });
        expect(attendeeStore.recordDelivery).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });
});
