import { describe, it, expect, vi } from 'vitest';
import { createMondayWebhookApp } from './route';
import type { MondayEventStore } from '../../db/mondayEvents';
import type { MapStore } from '../../db/map';
import type { MondayEventRow, QuickbooksSyncConfig } from '../../types';

function mondayEventRow(overrides: Partial<MondayEventRow> = {}): MondayEventRow {
  return {
    eventId: '42',
    mondayItemId: '42',
    rawPayload: '{}',
    status: 'received',
    qbId: null,
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    createAttempt: 0,
    createSends: 0,
    ...overrides,
  };
}

const config: QuickbooksSyncConfig = {
  monday: { apiUrl: 'https://api.monday.com/v2', boards: { customers: 789, invoices: null, products: null } },
  quickbooks: { apiBaseUrl: 'https://quickbooks.api.intuit.com/v3/company' },
  quickbooksSync: {
    columnMap: { customer: {}, invoice: {}, product: {} },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: {},
    customerQbIdColumn: null,
    currency: 'USD',
  },
};

function fakeMondayEventStore(overrides: Partial<MondayEventStore> = {}): MondayEventStore {
  return {
    insertEvent: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    findByQbId: vi.fn().mockResolvedValue(null),
    markCreateSent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMapStore(overrides: Partial<MapStore> = {}): MapStore {
  return {
    getByQbId: vi.fn().mockResolvedValue(null),
    getByMondayItemId: vi.fn().mockResolvedValue(null),
    createMapping: vi.fn().mockResolvedValue(undefined),
    repointMapping: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const SECRET = 'test-webhook-secret';
const WEBHOOK_URL = `/webhooks/monday?secret=${SECRET}`;

describe('createMondayWebhookApp', () => {
  it('echoes the challenge on subscription verification', async () => {
    const app = createMondayWebhookApp({
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      queue: { send: vi.fn() },
      config,
      mondayWebhookSecret: SECRET,
      writeMode: async () => 'on',
    });

    const res = await app.request(WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify({ challenge: 'abc123' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: 'abc123' });
  });

  it('rejects a request without the shared secret and enqueues nothing', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({
      mondayEventStore,
      mapStore: fakeMapStore(),
      queue,
      config,
      mondayWebhookSecret: SECRET,
      writeMode: async () => 'on',
    });

    const res = await app.request('/webhooks/monday', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(401);
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('rejects a request with the wrong shared secret and enqueues nothing', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({
      mondayEventStore,
      mapStore: fakeMapStore(),
      queue,
      config,
      mondayWebhookSecret: SECRET,
      writeMode: async () => 'on',
    });

    const res = await app.request('/webhooks/monday?secret=wrong', {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(401);
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('fails closed when the secret binding is unset or empty', async () => {
    // An undeployed/forgotten MONDAY_WEBHOOK_SECRET must reject everything, never
    // disable the check (no fail-open `!secret ||` shape).
    for (const missingSecret of [undefined, ''] as const) {
      const mondayEventStore = fakeMondayEventStore();
      const queue = { send: vi.fn() };
      const app = createMondayWebhookApp({
        mondayEventStore,
        mapStore: fakeMapStore(),
        queue,
        config,
        mondayWebhookSecret: missingSecret as unknown as string,
        writeMode: async () => 'on',
      });

      const res = await app.request(`/webhooks/monday?secret=${missingSecret ?? ''}`, {
        method: 'POST',
        body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status, `secret binding ${JSON.stringify(missingSecret)}`).toBe(401);
      expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
      expect(queue.send).not.toHaveBeenCalled();
    }
  });

  it('does not echo the challenge handshake without the correct shared secret', async () => {
    // The secret is part of the URL Monday registers, so the one-time challenge arrives
    // with it too — an unauthenticated challenge is an attacker probing the endpoint.
    const app = createMondayWebhookApp({
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      queue: { send: vi.fn() },
      config,
      mondayWebhookSecret: SECRET,
      writeMode: async () => 'on',
    });

    const res = await app.request('/webhooks/monday?secret=wrong', {
      method: 'POST',
      body: JSON.stringify({ challenge: 'abc123' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('abc123');
  });

  it('ignores an event from a board other than the configured Customers board', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const app = createMondayWebhookApp({
      mondayEventStore,
      mapStore: fakeMapStore(),
      queue: { send: vi.fn() },
      config,
      mondayWebhookSecret: SECRET,
      writeMode: async () => 'on',
    });

    const res = await app.request(WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 1, boardId: 999 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json<{ ignored: boolean }>()).ignored).toBe(true);
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
  });

  it('skips an item already linked in qb_monday_map instead of queueing an update', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const mapStore = fakeMapStore({
      getByMondayItemId: vi.fn().mockResolvedValue({
        entityType: 'customer',
        qbId: 'qb-1',
        mondayItemId: '1',
        mondayBoardId: 789,
        createdAt: '2026-08-22T00:00:00.000Z',
      }),
    });
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore, queue, config, mondayWebhookSecret: SECRET, writeMode: async () => 'on' });

    const res = await app.request(WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 1, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json<{ alreadyLinked: boolean }>()).alreadyLinked).toBe(true);
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('dedupes and enqueues a genuinely new Customer item', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config, mondayWebhookSecret: SECRET, writeMode: async () => 'on' });

    const res = await app.request(WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789, columnValues: { text_col: 'New Co' } } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(mondayEventStore.insertEvent).toHaveBeenCalledWith({
      eventId: '42',
      mondayItemId: '42',
      rawPayload: JSON.stringify({ text_col: 'New Co' }),
      receivedAt: expect.any(String),
    });
    expect(queue.send).toHaveBeenCalledWith({ direction: 'monday-to-qb', eventId: '42' });
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'queued');
  });

  it('short-circuits on a duplicate item event whose row already reached the queue', async () => {
    const mondayEventStore = fakeMondayEventStore({
      insertEvent: vi.fn().mockResolvedValue('duplicate'),
      getEvent: vi.fn().mockResolvedValue(mondayEventRow({ status: 'queued' })),
    });
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config, mondayWebhookSecret: SECRET, writeMode: async () => 'on' });

    const res = await app.request(WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect((await res.json<{ duplicate: boolean }>()).duplicate).toBe(true);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('resumes a duplicate item event whose row never reached the queue', async () => {
    // The row exists in a pre-queue state because a prior delivery died between the insert and
    // the enqueue. Skipping it here would lose the new Customer permanently.
    for (const status of ['received', 'fetched', 'failed'] as const) {
      const mondayEventStore = fakeMondayEventStore({
        insertEvent: vi.fn().mockResolvedValue('duplicate'),
        getEvent: vi.fn().mockResolvedValue(mondayEventRow({ status })),
      });
      const queue = { send: vi.fn().mockResolvedValue(undefined) };
      const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config, mondayWebhookSecret: SECRET, writeMode: async () => 'on' });

      const res = await app.request(WEBHOOK_URL, {
        method: 'POST',
        body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
      expect((await res.json<{ resumed: boolean }>()).resumed, `status ${status}`).toBe(true);
      expect(queue.send, `status ${status}`).toHaveBeenCalledWith({ direction: 'monday-to-qb', eventId: '42' });
      expect(mondayEventStore.updateStatus, `status ${status}`).toHaveBeenCalledWith('42', 'queued');
    }
  });

  it('returns 5xx and records the row failed when the enqueue throws, so Monday redelivers', async () => {
    // A 200 here would tell Monday the delivery succeeded — create_pulse fires once per item,
    // so without a redelivery the resume branch never runs and the customer never reaches
    // QuickBooks.
    const mondayEventStore = fakeMondayEventStore();
    const queue = { send: vi.fn().mockRejectedValue(new Error('queue unavailable')) };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config, mondayWebhookSecret: SECRET, writeMode: async () => 'on' });

    const res = await app.request(WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false });
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'failed', {
      error: 'queue unavailable',
    });
    expect(mondayEventStore.updateStatus).not.toHaveBeenCalledWith('42', 'queued');
  });

  it('re-enqueues on redelivery after a failed enqueue was recorded', async () => {
    // Second half of the retry loop: the 5xx above makes Monday redeliver; the recorded
    // 'failed' row (not hasReachedQueue) is what lets this delivery resume idempotently.
    const mondayEventStore = fakeMondayEventStore({
      insertEvent: vi.fn().mockResolvedValue('duplicate'),
      getEvent: vi.fn().mockResolvedValue(mondayEventRow({ status: 'failed', error: 'queue unavailable' })),
    });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config, mondayWebhookSecret: SECRET, writeMode: async () => 'on' });

    const res = await app.request(WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 42, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect((await res.json<{ ok: boolean; resumed: boolean }>()).resumed).toBe(true);
    expect(queue.send).toHaveBeenCalledWith({ direction: 'monday-to-qb', eventId: '42' });
    expect(mondayEventStore.updateStatus).toHaveBeenCalledWith('42', 'queued');
  });

  it('returns a recorded error at HTTP 200 for a malformed JSON body instead of crashing', async () => {
    const mondayEventStore = fakeMondayEventStore();
    const queue = { send: vi.fn() };
    const app = createMondayWebhookApp({ mondayEventStore, mapStore: fakeMapStore(), queue, config, mondayWebhookSecret: SECRET, writeMode: async () => 'on' });

    const res = await app.request(WEBHOOK_URL, {
      method: 'POST',
      body: 'not json at all{',
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    const json = await res.json<{ ok: boolean; error: string }>();
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
    expect(mondayEventStore.insertEvent).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });
});

// The write switch (src/flags.ts): ingest runs in every mode; under `off` the queued message is
// stamped so the consumer dry-runs it even if the mode is flipped to `on` first.
describe('createMondayWebhookApp — write switch', () => {
  async function postWithMode(mode: 'on' | 'hold' | 'off' | 'unknown') {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const app = createMondayWebhookApp({
      mondayEventStore: fakeMondayEventStore(),
      mapStore: fakeMapStore(),
      queue,
      config,
      mondayWebhookSecret: SECRET,
      writeMode: async () => mode,
    });
    const res = await app.request(WEBHOOK_URL, {
      method: 'POST',
      body: JSON.stringify({ event: { pulseId: 1, boardId: 789 } }),
      headers: { 'Content-Type': 'application/json' },
    });
    return { res, queue };
  }

  it("stamps the message 'dropped' under off", async () => {
    const { res, queue } = await postWithMode('off');
    expect(res.status).toBe(200);
    expect(queue.send).toHaveBeenCalledWith({ direction: 'monday-to-qb', eventId: '1', writeStamp: 'dropped' });
  });

  it.each(['on', 'hold', 'unknown'] as const)('leaves the message unstamped under %s', async (mode) => {
    const { queue } = await postWithMode(mode);
    expect(queue.send).toHaveBeenCalledWith({ direction: 'monday-to-qb', eventId: '1' });
  });
});
