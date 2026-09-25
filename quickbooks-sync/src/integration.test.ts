import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import { processSyncQueueBatch, type QueueMessageLike } from './consumer/processBatch';
import { D1MapStore } from './db/map';
import { D1MondayEventStore } from './db/mondayEvents';
import { D1QbEventStore } from './db/qbEvents';
import type { MondayClient } from './monday/client';
import { createMondayWebhookApp } from './monday/webhook/route';
import type { QuickBooksClient } from './quickbooks/client';
import { createQbWebhookApp } from './quickbooks/webhook/route';
import type { QueueMessage, QuickbooksSyncConfig } from './types';

// End-to-end coverage of the webhook → D1 → queue → consumer seam. Everything between the two
// ends is real: real Hono routes, real D1-backed stores, the real consumer. Only the two
// outbound API clients and Cloudflare Queues itself are faked.

const config: QuickbooksSyncConfig = {
  monday: { apiUrl: 'https://api.monday.com/v2', boards: { customers: 789, invoices: 456, products: 123 } },
  quickbooks: { apiBaseUrl: 'https://quickbooks.api.intuit.com/v3/company' },
  quickbooksSync: {
    columnMap: {
      customer: { DisplayName: 'text_col', 'PrimaryEmailAddr.Address': 'email_col' },
      invoice: { DocNumber: 'text_col' },
      product: { Name: 'text_col' },
    },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: { name: 'DisplayName', email_col: 'PrimaryEmailAddr.Address' },
    customerQbIdColumn: 'qb_id_col',
  },
};

const verifierToken = 'integration-verifier-token';

/** In-memory stand-in for Cloudflare Queues: collects what the routes enqueue. */
function fakeQueue() {
  const sent: QueueMessage[] = [];
  return {
    sent,
    async send(message: QueueMessage): Promise<void> {
      sent.push(message);
    },
  };
}

/** Wraps collected queue bodies as the message envelope the consumer expects. */
function toConsumerMessages(sent: QueueMessage[]): (QueueMessageLike<QueueMessage> & { ack: any; retry: any })[] {
  return sent.map((body) => ({ body, ack: vi.fn(), retry: vi.fn() }));
}

async function signQbBody(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(verifierToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

let nextMondayItemId = 1;

/**
 * In-memory stand-in for one Monday account: items keep the column values they were created or
 * changed with, so getItem and the column-value search see what create_item/changes wrote —
 * which is what the create-loop guard relies on. `seed` pre-creates items (e.g. staff-typed).
 */
function fakeMondayClient(overrides: Partial<MondayClient> = {}, seed: Record<string, { name: string; columns: Record<string, unknown> }> = {}) {
  const items = new Map(Object.entries(seed).map(([id, item]) => [id, { ...item, columns: { ...item.columns } }]));
  const cell = (value: unknown) => ({
    text: typeof value === 'string' ? value : value === undefined ? null : JSON.stringify(value),
    value: value === undefined ? null : JSON.stringify(value),
  });
  const client = {
    items,
    createItem: vi.fn(async (_boardId: number, itemName: string, columnValues: Record<string, unknown>) => {
      // Unique across the file: D1 (and so every mapping and monday_events row) is shared by all tests.
      const id = `monday-item-${nextMondayItemId++}`;
      items.set(id, { name: itemName, columns: { ...columnValues } });
      return { id };
    }),
    changeColumnValues: vi.fn(async (_boardId: number, itemId: string, columnValues: Record<string, unknown>) => {
      const item = items.get(itemId);
      if (item) Object.assign(item.columns, columnValues);
    }),
    getItem: vi.fn(async (itemId: string) => {
      const item = items.get(itemId);
      if (!item) return null;
      return { id: itemId, name: item.name, columnValues: Object.fromEntries(Object.entries(item.columns).map(([k, v]) => [k, cell(v)])) };
    }),
    findItemIdsByColumnValue: vi.fn(async (_boardId: number, columnId: string, value: string) =>
      [...items].filter(([, item]) => item.columns[columnId] === value).map(([id]) => id)
    ),
  } satisfies MondayClient & { items: unknown };
  return Object.assign(client, overrides);
}

function fakeQuickBooksClient(overrides: Partial<QuickBooksClient> = {}): QuickBooksClient {
  return {
    getEntity: vi.fn().mockResolvedValue({
      Id: '60',
      DisplayName: 'Acme Co',
      PrimaryEmailAddr: { Address: 'ap@acme.test' },
    }),
    createCustomer: vi.fn().mockResolvedValue({ id: 'qb-created-1' }),
    ...overrides,
  };
}

const qbEventId = '123:Customer:60:2026-08-22T00:00:00.000Z';

const qbNotification = {
  eventNotifications: [
    {
      realmId: '123',
      dataChangeEvent: {
        entities: [{ name: 'Customer', id: '60', operation: 'Create', lastUpdated: '2026-08-22T00:00:00.000Z' }],
      },
    },
  ],
};

describe('integration: QuickBooks → D1 → queue → consumer → Monday', () => {
  it('carries a change notification all the way to a created Monday item', async () => {
    const qbEventStore = new D1QbEventStore(env.DB);
    const mapStore = new D1MapStore(env.DB);
    const queue = fakeQueue();
    const quickBooksClient = fakeQuickBooksClient();
    const mondayClient = fakeMondayClient();

    const app = createQbWebhookApp({ qbEventStore, queue, verifierToken, connectedRealmId: async () => '123' });
    const body = JSON.stringify(qbNotification);
    const res = await app.request('/webhooks/quickbooks', {
      method: 'POST',
      body,
      headers: { 'intuit-signature': await signQbBody(body) },
    });

    expect(res.status).toBe(200);
    expect(queue.sent).toEqual([{ direction: 'qb-to-monday', eventId: qbEventId }]);

    const queuedRow = await qbEventStore.getEvent(qbEventId);
    expect(queuedRow?.status).toBe('queued');
    expect(queuedRow?.qbId).toBe('60');
    // The webhook no longer calls QuickBooks (#33); the consumer fetches.
    expect(quickBooksClient.getEntity).not.toHaveBeenCalled();
    expect(queuedRow?.fetchedPayload).toBeNull();

    const messages = toConsumerMessages(queue.sent);
    await processSyncQueueBatch(messages, {
      qbEventStore,
      mondayEventStore: new D1MondayEventStore(env.DB),
      mapStore,
      mondayClient,
      quickBooksClient,
      config,
    });

    expect(messages[0]!.ack).toHaveBeenCalled();
    expect(messages[0]!.retry).not.toHaveBeenCalled();
    expect(mondayClient.createItem).toHaveBeenCalledWith(789, 'Acme Co', {
      text_col: 'Acme Co',
      email_col: 'ap@acme.test',
      qb_id_col: '60',
    });

    expect(quickBooksClient.getEntity).toHaveBeenCalledWith('customer', '60');
    const writtenRow = await qbEventStore.getEvent(qbEventId);
    expect(writtenRow?.status).toBe('written');
    expect(writtenRow?.writtenAt).not.toBeNull();
    expect(JSON.parse(writtenRow!.fetchedPayload!).DisplayName).toBe('Acme Co');

    expect(await mapStore.getByQbId('customer', '60')).toEqual({
      entityType: 'customer',
      qbId: '60',
      mondayItemId: 'monday-item-1',
      mondayBoardId: 789,
      createdAt: expect.any(String),
    });
  });
});

describe('integration: Monday → D1 → queue → consumer → QuickBooks', () => {
  // A staff-typed item as Monday stores it; the consumer re-reads it before creating.
  const staffTypedItem = { name: 'New Org', columns: { email_col: { email: 'hello@neworg.test', text: 'hello@neworg.test' } } };

  // D1 state is shared across tests in this harness, so each test drives a distinct Monday item.
  async function runMondayWebhook(
    pulseId: number,
    deps: {
      mondayEventStore: D1MondayEventStore;
      mapStore: D1MapStore;
      queue: ReturnType<typeof fakeQueue>;
    }
  ) {
    const app = createMondayWebhookApp({ ...deps, config, mondayWebhookSecret: 'integration-secret' });
    return app.request('/webhooks/monday?secret=integration-secret', {
      method: 'POST',
      body: JSON.stringify({
        // The shape Monday's create_pulse webhook actually sends: the name as pulseName, and
        // column values in their raw per-type shapes.
        event: {
          type: 'create_pulse',
          pulseId,
          pulseName: 'New Org',
          boardId: 789,
          columnValues: { email_col: { email: 'hello@neworg.test', text: 'hello@neworg.test' } },
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    });
  }

  it('carries a new board item all the way to a created QuickBooks Customer', async () => {
    const mondayEventStore = new D1MondayEventStore(env.DB);
    const mapStore = new D1MapStore(env.DB);
    const queue = fakeQueue();
    const quickBooksClient = fakeQuickBooksClient();

    const res = await runMondayWebhook(42, { mondayEventStore, mapStore, queue });
    expect(res.status).toBe(200);
    expect(queue.sent).toEqual([{ direction: 'monday-to-qb', eventId: '42' }]);
    expect((await mondayEventStore.getEvent('42'))?.status).toBe('queued');

    const messages = toConsumerMessages(queue.sent);
    await processSyncQueueBatch(messages, {
      qbEventStore: new D1QbEventStore(env.DB),
      mondayEventStore,
      mapStore,
      mondayClient: fakeMondayClient({}, { '42': staffTypedItem }),
      quickBooksClient,
      config,
    });

    expect(messages[0]!.ack).toHaveBeenCalled();
    expect(quickBooksClient.createCustomer).toHaveBeenCalledWith(
      { DisplayName: 'New Org', PrimaryEmailAddr: { Address: 'hello@neworg.test' } },
      'monday-item-42'
    );

    const writtenRow = await mondayEventStore.getEvent('42');
    expect(writtenRow?.status).toBe('written');
    expect(writtenRow?.qbId).toBe('qb-created-1');

    expect(await mapStore.getByMondayItemId('customer', '42')).toEqual({
      entityType: 'customer',
      qbId: 'qb-created-1',
      mondayItemId: '42',
      mondayBoardId: 789,
      createdAt: expect.any(String),
    });
  });

  it('does not create a second QuickBooks Customer when the same event is processed again', async () => {
    // Integration-level proof of the retry-idempotency guard: the first pass writes qbId into the
    // real D1 row, and a redelivery of the same message reads it back and skips createCustomer
    // rather than duplicating the Customer in the accounting system of record.
    const mondayEventStore = new D1MondayEventStore(env.DB);
    const mapStore = new D1MapStore(env.DB);
    const queue = fakeQueue();
    const quickBooksClient = fakeQuickBooksClient({
      createCustomer: vi.fn().mockResolvedValue({ id: 'qb-created-2' }),
    });
    const consumerDeps = {
      qbEventStore: new D1QbEventStore(env.DB),
      mondayEventStore,
      mapStore,
      mondayClient: fakeMondayClient({}, { '43': staffTypedItem }),
      quickBooksClient,
      config,
    };

    await runMondayWebhook(43, { mondayEventStore, mapStore, queue });
    await processSyncQueueBatch(toConsumerMessages(queue.sent), consumerDeps);
    expect(quickBooksClient.createCustomer).toHaveBeenCalledTimes(1);

    const redelivered = toConsumerMessages(queue.sent);
    await processSyncQueueBatch(redelivered, consumerDeps);

    expect(quickBooksClient.createCustomer).toHaveBeenCalledTimes(1);
    expect(redelivered[0]!.ack).toHaveBeenCalled();
    expect(redelivered[0]!.retry).not.toHaveBeenCalled();

    const row = await mondayEventStore.getEvent('43');
    expect(row?.status).toBe('written');
    expect(row?.qbId).toBe('qb-created-2');
    expect((await mapStore.getByMondayItemId('customer', '43'))?.qbId).toBe('qb-created-2');
  });
});

// #33: the create loop, end to end against real D1. A QuickBooks-originated Customer is created
// on Monday before its mapping exists; Monday's create_pulse webhook for that new item arrives in
// between. It must never become a second QuickBooks Customer, and must not hold up unrelated
// staff-created Customers. The Monday fake is stateful, so the QuickBooks Id column that
// create_item writes is what getItem and the column search read back.
describe('integration: create loop (QuickBooks-created item echoed back by Monday)', () => {
  const realmId = '123';

  function setup(qbId: string, displayName: string) {
    const qbEventStore = new D1QbEventStore(env.DB);
    const mondayEventStore = new D1MondayEventStore(env.DB);
    const mapStore = new D1MapStore(env.DB);
    const qbQueue = fakeQueue();
    const mondayQueue = fakeQueue();
    const quickBooksClient = fakeQuickBooksClient({
      getEntity: vi.fn().mockResolvedValue({ Id: qbId, DisplayName: displayName }),
      createCustomer: vi.fn(),
    });
    const mondayClient = fakeMondayClient();
    const qbApp = createQbWebhookApp({ qbEventStore, queue: qbQueue, verifierToken, connectedRealmId: async () => realmId });
    const mondayApp = createMondayWebhookApp({ mondayEventStore, mapStore, queue: mondayQueue, config, mondayWebhookSecret: 's' });
    const consumerDeps: Parameters<typeof processSyncQueueBatch>[1] = { qbEventStore, mondayEventStore, mapStore, mondayClient, quickBooksClient, config };
    // Monday's create_pulse for an item, and a consumer run for it.
    const echo = async (itemId: string, deps = consumerDeps) => {
      await mondayApp.request('/webhooks/monday?secret=s', {
        method: 'POST',
        body: JSON.stringify({ event: { type: 'create_pulse', pulseId: itemId, pulseName: 'Echo', boardId: 789, columnValues: {} } }),
      });
      const messages = toConsumerMessages(mondayQueue.sent.splice(0));
      await processSyncQueueBatch(messages, deps);
      return messages;
    };
    // Intuit's change notification for the Customer, recorded and enqueued (not yet consumed).
    const notify = async () => {
      const body = JSON.stringify({
        eventNotifications: [
          { realmId, dataChangeEvent: { entities: [{ name: 'Customer', id: qbId, operation: 'Create', lastUpdated: '2026-09-25T00:00:00.000Z' }] } },
        ],
      });
      await qbApp.request('/webhooks/quickbooks', { method: 'POST', body, headers: { 'intuit-signature': await signQbBody(body) } });
      return toConsumerMessages(qbQueue.sent.splice(0));
    };
    const flakyMapStore = () => ({
      getByQbId: mapStore.getByQbId.bind(mapStore),
      getByMondayItemId: mapStore.getByMondayItemId.bind(mapStore),
      createMapping: vi.fn().mockRejectedValueOnce(new Error('D1_ERROR: overloaded')).mockImplementation(mapStore.createMapping.bind(mapStore)),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { qbEventStore, mondayEventStore, mapStore, mondayClient, quickBooksClient, consumerDeps, echo, notify, flakyMapStore };
  }

  it('the echo arrives while create_item is still returning: adopted from the item, not deferred, no Customer', async () => {
    const t = setup('500', 'Echo Co');
    const store = t.mondayClient.createItem.getMockImplementation()!;
    let echoMessages: ReturnType<typeof toConsumerMessages> = [];
    t.mondayClient.createItem.mockImplementationOnce(async (...args) => {
      const created = await store(...args);
      echoMessages = await t.echo(created.id); // before the item id or mapping is anywhere in D1
      return created;
    });

    const qbMessages = await t.notify();
    await processSyncQueueBatch(qbMessages, t.consumerDeps);

    expect(echoMessages[0]!.ack).toHaveBeenCalled();
    expect(echoMessages[0]!.retry).not.toHaveBeenCalled(); // no deferral, no burned attempt
    expect(qbMessages[0]!.ack).toHaveBeenCalled();
    expect(t.quickBooksClient.createCustomer).not.toHaveBeenCalled();
    expect(t.mondayClient.createItem).toHaveBeenCalledTimes(1);
    const itemId = (await t.mapStore.getByQbId('customer', '500'))!.mondayItemId;
    expect((await t.mondayEventStore.getEvent(itemId))?.qbId).toBe('500');
    vi.restoreAllMocks();
  });

  it("create_item's response is lost, then the echo: adopted; the retry reuses the item — no duplicates", async () => {
    const t = setup('502', 'Lost Response Co');
    const store = t.mondayClient.createItem.getMockImplementation()!;
    let lostId = '';
    t.mondayClient.createItem.mockImplementationOnce(async (...args) => {
      lostId = (await store(...args)).id; // Monday made the item...
      throw new Error('monday API: HTTP 504'); // ...but we never heard back
    });

    const qbMessages = await t.notify();
    await processSyncQueueBatch(qbMessages, t.consumerDeps);
    expect(qbMessages[0]!.retry).toHaveBeenCalled();

    const echo = await t.echo(lostId);
    expect(echo[0]!.ack).toHaveBeenCalled();
    expect(t.quickBooksClient.createCustomer).not.toHaveBeenCalled();

    const retried = toConsumerMessages([qbMessages[0]!.body]);
    await processSyncQueueBatch(retried, t.consumerDeps);
    expect(retried[0]!.ack).toHaveBeenCalled();
    expect(t.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect((await t.mapStore.getByQbId('customer', '502'))?.mondayItemId).toBe(lostId);
    vi.restoreAllMocks();
  });

  it("create_item's response is lost and the retry runs first: it finds the item by its QuickBooks Id", async () => {
    const t = setup('503', 'Retry First Co');
    const store = t.mondayClient.createItem.getMockImplementation()!;
    let lostId = '';
    t.mondayClient.createItem.mockImplementationOnce(async (...args) => {
      lostId = (await store(...args)).id;
      throw new Error('monday API: HTTP 504');
    });

    const qbMessages = await t.notify();
    await processSyncQueueBatch(qbMessages, t.consumerDeps);
    const retried = toConsumerMessages([qbMessages[0]!.body]);
    await processSyncQueueBatch(retried, t.consumerDeps);

    expect(retried[0]!.ack).toHaveBeenCalled();
    expect(t.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect((await t.mapStore.getByQbId('customer', '503'))?.mondayItemId).toBe(lostId);

    // The echo now finds the mapping at the webhook and is never enqueued.
    const echo = await t.echo(lostId);
    expect(echo).toEqual([]);
    expect(t.quickBooksClient.createCustomer).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  // Review #5: the other direction. A staff-typed item becomes a QuickBooks Customer, the mapping
  // write fails, and QuickBooks' own notification for that new Customer is consumed first.
  it('a Customer created from a Monday item is linked back to it, not turned into a second item', async () => {
    const t = setup('qb-from-monday', 'Staff Co');
    t.mondayClient.items.set('staff-item-1', { name: 'Staff Co', columns: {} });
    t.quickBooksClient.createCustomer = vi.fn().mockResolvedValue({ id: 'qb-from-monday' });

    const staff = await t.echo('staff-item-1', { ...t.consumerDeps, mapStore: t.flakyMapStore() });
    expect(staff[0]!.retry).toHaveBeenCalled(); // Customer created, mapping write failed

    const qbMessages = await t.notify();
    await processSyncQueueBatch(qbMessages, t.consumerDeps);
    expect(qbMessages[0]!.ack).toHaveBeenCalled();
    expect(t.mondayClient.createItem).not.toHaveBeenCalled();
    expect((await t.mapStore.getByQbId('customer', 'qb-from-monday'))?.mondayItemId).toBe('staff-item-1');

    const retried = toConsumerMessages([staff[0]!.body]);
    await processSyncQueueBatch(retried, t.consumerDeps);
    expect(retried[0]!.ack).toHaveBeenCalled();
    expect(t.quickBooksClient.createCustomer).toHaveBeenCalledTimes(1);
    expect(t.mondayClient.items.get('staff-item-1')!.columns.qb_id_col).toBe('qb-from-monday');
    vi.restoreAllMocks();
  });

  it('adopts the echo when the QuickBooks side recorded the item id but failed to write the mapping', async () => {
    const t = setup('501', 'Echo Two');

    const qbMessages = await t.notify();
    await processSyncQueueBatch(qbMessages, { ...t.consumerDeps, mapStore: t.flakyMapStore() });
    expect(qbMessages[0]!.retry).toHaveBeenCalled();
    const itemId = (await t.qbEventStore.getEvent(qbMessages[0]!.body.eventId))!.pendingMondayItemId!;

    // Monday's echo arrives before the QuickBooks-side retry (which is delayed by backoff).
    const echo = await t.echo(itemId);
    expect(echo[0]!.ack).toHaveBeenCalled();
    expect(t.quickBooksClient.createCustomer).not.toHaveBeenCalled();
    expect((await t.mapStore.getByMondayItemId('customer', itemId))?.qbId).toBe('501');

    // The QuickBooks-side retry then finds the mapping and updates instead of creating again.
    const retried = toConsumerMessages([qbMessages[0]!.body]);
    await processSyncQueueBatch(retried, t.consumerDeps);
    expect(retried[0]!.ack).toHaveBeenCalled();
    expect(t.mondayClient.createItem).toHaveBeenCalledTimes(1);
    expect(t.mondayClient.changeColumnValues).toHaveBeenCalledWith(789, itemId, expect.objectContaining({ name: 'Echo Two' }));
    vi.restoreAllMocks();
  });
});
