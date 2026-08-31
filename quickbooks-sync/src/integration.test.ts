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
  quickbooksSync: {
    columnMap: {
      customer: { DisplayName: 'text_col', 'PrimaryEmailAddr.Address': 'email_col' },
      invoice: { DocNumber: 'text_col' },
      product: { Name: 'text_col' },
    },
    itemNameField: { customer: 'DisplayName', invoice: 'DocNumber', product: 'Name' },
    linkColumn: { invoice: 'connect_col' },
    customerCreateFieldMap: { text_col: 'DisplayName', email_col: 'PrimaryEmailAddr.Address' },
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

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    createItem: vi.fn().mockResolvedValue({ id: 'monday-item-1' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
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

    const app = createQbWebhookApp({ qbEventStore, quickBooksClient, queue, verifierToken });
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
    expect(JSON.parse(queuedRow!.fetchedPayload!).DisplayName).toBe('Acme Co');

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
    });

    const writtenRow = await qbEventStore.getEvent(qbEventId);
    expect(writtenRow?.status).toBe('written');
    expect(writtenRow?.writtenAt).not.toBeNull();

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
        event: { pulseId, boardId: 789, columnValues: { text_col: 'New Org', email_col: 'hello@neworg.test' } },
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
      mondayClient: fakeMondayClient(),
      quickBooksClient,
      config,
    });

    expect(messages[0]!.ack).toHaveBeenCalled();
    expect(quickBooksClient.createCustomer).toHaveBeenCalledWith({
      DisplayName: 'New Org',
      PrimaryEmailAddr: { Address: 'hello@neworg.test' },
    });

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
      mondayClient: fakeMondayClient(),
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
