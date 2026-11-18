import { describe, it, expect, vi } from 'vitest';
import { createQbWebhookApp, type BatchQueueLike } from './route';
import type { NewQbEvent, QbEventStore, RecordResult } from '../../db/qbEvents';
import type { QueueMessage, SyncStatus } from '../../types';

// Every row is new unless `existing` names its event id with the status already on file.
function fakeEventStore(existing: Record<string, SyncStatus> = {}): QbEventStore & {
  recordEvents: ReturnType<typeof vi.fn>;
  markEvents: ReturnType<typeof vi.fn>;
} {
  return {
    recordEvents: vi.fn(async (rows: readonly NewQbEvent[]): Promise<RecordResult[]> =>
      rows.map((row) => {
        const status = existing[row.eventId];
        return status === undefined ? { inserted: true } : { inserted: false, status };
      })
    ),
    markEvents: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn(),
    getEvent: vi.fn(),
    findByPendingMondayItemId: vi.fn(),
  };
}

function fakeQueue(sendBatch = vi.fn().mockResolvedValue(undefined)) {
  return { sendBatch };
}

// Every message the route enqueued, across sendBatch calls.
function sent(queue: { sendBatch: ReturnType<typeof vi.fn> }): QueueMessage[] {
  return queue.sendBatch.mock.calls.flatMap(([messages]) => messages as QueueMessage[]);
}

const EVENT_ID = '123:Customer:60:2026-08-22T00:00:00.000Z';

const verifierToken = 'test-verifier-token';

async function signedBody(payload: unknown): Promise<{ body: string; signature: string }> {
  const body = JSON.stringify(payload);
  const signature = await verifyQbSignatureHelper(body);
  return { body, signature };
}

// Reuses the exact algorithm verifyQbSignature checks against, so tests sign requests the same way Intuit would.
async function verifyQbSignatureHelper(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(verifierToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));
}

const notificationPayload = {
  eventNotifications: [
    {
      realmId: '123',
      dataChangeEvent: {
        entities: [{ name: 'Customer', id: '60', operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' }],
      },
    },
  ],
};

describe('createQbWebhookApp', () => {
  // GL#68: an unset verifier token used to reach crypto.subtle.importKey, which throws on the empty
  // key, so the refusal was an accident of an unhandled 500. It is now an explicit one.
  it.each([undefined, ''])('refuses every delivery, without throwing, when the verifier token is %j', async (missingToken) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const eventStore = fakeEventStore();
    const queue = fakeQueue();
    const { body, signature } = await signedBody(notificationPayload);
    const res = await createQbWebhookApp({
      qbEventStore: eventStore,
      queue,
      verifierToken: missingToken as unknown as string,
      connectedRealmId: async () => '123',
      writeMode: async () => 'on',
    }).request('/webhooks/quickbooks', { method: 'POST', body, headers: { 'intuit-signature': signature } });

    expect(res.status).toBe(401);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('QB_WEBHOOK_VERIFIER_TOKEN'));
    expect(eventStore.recordEvents).not.toHaveBeenCalled();
    expect(queue.sendBatch).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  function app(eventStore: QbEventStore, queue: BatchQueueLike, connectedRealmId: string | null = '123') {
    return createQbWebhookApp({
      qbEventStore: eventStore,
      queue,
      verifierToken,
      connectedRealmId: async () => connectedRealmId,
      writeMode: async () => 'on',
    });
  }

  async function post(
    eventStore: QbEventStore,
    queue: BatchQueueLike,
    payload: unknown = notificationPayload,
    connectedRealmId: string | null = '123'
  ) {
    const { body, signature } = await signedBody(payload);
    return app(eventStore, queue, connectedRealmId).request('/webhooks/quickbooks', {
      method: 'POST',
      body,
      headers: { 'intuit-signature': signature },
    });
  }

  function entities(...list: Array<{ name: string; id: string; operation: string; lastUpdated: string; deletedId?: string }>) {
    return { eventNotifications: [{ realmId: '123', dataChangeEvent: { entities: list } }] };
  }

  it('rejects a request with an invalid signature', async () => {
    const eventStore = fakeEventStore();
    const res = await app(eventStore, fakeQueue()).request('/webhooks/quickbooks', {
      method: 'POST',
      body: JSON.stringify(notificationPayload),
      headers: { 'intuit-signature': 'wrong-signature' },
    });

    expect(res.status).toBe(401);
    expect(eventStore.recordEvents).not.toHaveBeenCalled();
  });

  // GL#33: the webhook used to fetch the entity inline and answer 200 even when that failed, so
  // Intuit never redelivered and the change was lost. It now only records and enqueues; the
  // consumer fetches (with queue retries and a DLQ behind it).
  it('records and enqueues a new notification without calling QuickBooks', async () => {
    const eventStore = fakeEventStore();
    const queue = fakeQueue();

    const res = await post(eventStore, queue);

    expect(res.status).toBe(200);
    expect(eventStore.recordEvents).toHaveBeenCalledWith([
      { eventId: EVENT_ID, entityType: 'customer', qbId: '60', receivedAt: expect.any(String) },
    ]);
    expect(sent(queue)).toEqual([{ direction: 'qb-to-monday', eventId: EVENT_ID }]);
    expect(eventStore.markEvents).toHaveBeenCalledWith([EVENT_ID], 'queued');
  });

  // GL#101: a delivery used to cost three sequential round trips per notification.
  it('records, enqueues and marks a whole delivery in one call each', async () => {
    const eventStore = fakeEventStore();
    const queue = fakeQueue();
    const list = Array.from({ length: 5 }, (_, i) => ({ name: 'Invoice', id: `${i}`, operation: 'Create', lastUpdated: '2026-08-22T00:00:00.000Z' }));

    const res = await post(eventStore, queue, entities(...list));

    expect(res.status).toBe(200);
    expect(eventStore.recordEvents).toHaveBeenCalledTimes(1);
    expect(queue.sendBatch).toHaveBeenCalledTimes(1);
    expect(sent(queue)).toHaveLength(5);
    expect(eventStore.markEvents).toHaveBeenCalledTimes(1);
  });

  it('splits more than 100 messages across sendBatch calls', async () => {
    const eventStore = fakeEventStore();
    const queue = fakeQueue();
    const list = Array.from({ length: 150 }, (_, i) => ({ name: 'Invoice', id: `${i}`, operation: 'Create', lastUpdated: '2026-08-22T00:00:00.000Z' }));

    await post(eventStore, queue, entities(...list));

    expect(queue.sendBatch.mock.calls.map(([m]) => m.length)).toEqual([100, 50]);
    expect(eventStore.markEvents.mock.calls[0]?.[0]).toHaveLength(150);
  });

  it('records an entity repeated in one payload once', async () => {
    const eventStore = fakeEventStore();
    const queue = fakeQueue();
    const customer = { name: 'Customer', id: '60', operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' };

    await post(eventStore, queue, entities(customer, customer));

    expect(eventStore.recordEvents.mock.calls[0]?.[0]).toHaveLength(1);
    expect(sent(queue)).toHaveLength(1);
  });

  it('short-circuits on a duplicate notification whose row already reached the queue', async () => {
    for (const status of ['queued', 'written'] as const) {
      const eventStore = fakeEventStore({ [EVENT_ID]: status });
      const queue = fakeQueue();

      const res = await post(eventStore, queue);

      expect(res.status).toBe(200);
      expect(queue.sendBatch, `status ${status}`).not.toHaveBeenCalled();
      expect(eventStore.markEvents, `status ${status}`).not.toHaveBeenCalled();
    }
  });

  it('resumes a duplicate notification whose row never reached the queue', async () => {
    // The row exists in a pre-queue state because a prior delivery died between the insert and
    // the enqueue. Skipping it here would lose the change permanently.
    for (const status of ['received', 'fetched', 'failed'] as const) {
      const eventStore = fakeEventStore({ [EVENT_ID]: status });
      const queue = fakeQueue();

      const res = await post(eventStore, queue);

      expect(res.status).toBe(200);
      expect(sent(queue), `status ${status}`).toEqual([{ direction: 'qb-to-monday', eventId: EVENT_ID }]);
      expect(eventStore.markEvents, `status ${status}`).toHaveBeenCalledWith([EVENT_ID], 'queued');
    }
  });

  it('enqueues only the new and resumable rows of a partly redelivered payload', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((id) => `123:Invoice:${id}:2026-08-22T00:00:00.000Z`) as [string, string, string];
    const eventStore = fakeEventStore({ [b]: 'queued', [c]: 'failed' });
    const queue = fakeQueue();

    await post(eventStore, queue, entities(...['a', 'b', 'c'].map((id) => ({ name: 'Invoice', id, operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' }))));

    expect(sent(queue).map((m) => m.eventId)).toEqual([a, c]);
    expect(eventStore.markEvents).toHaveBeenCalledWith([a, c], 'queued');
  });

  it('answers 500 when the enqueue fails, so Intuit redelivers, and marks the row resumable', async () => {
    const eventStore = fakeEventStore();
    const queue = fakeQueue(vi.fn().mockRejectedValue(new Error('queue unavailable')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(eventStore, queue);

    expect(res.status).toBe(500);
    expect(eventStore.markEvents).toHaveBeenCalledWith([EVENT_ID], 'failed', 'queue unavailable');
    expect(eventStore.markEvents).not.toHaveBeenCalledWith(expect.anything(), 'queued');
    errorSpy.mockRestore();
  });

  it('still enqueues the other chunks of the payload when one sendBatch fails', async () => {
    const eventStore = fakeEventStore();
    const queue = fakeQueue(vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockResolvedValue(undefined));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const list = Array.from({ length: 101 }, (_, i) => ({ name: 'Invoice', id: `${i}`, operation: 'Create', lastUpdated: '2026-08-22T00:00:00.000Z' }));

    const res = await post(eventStore, queue, entities(...list));

    expect(res.status).toBe(500);
    expect(queue.sendBatch).toHaveBeenCalledTimes(2);
    expect(eventStore.markEvents.mock.calls[0]?.[0]).toHaveLength(100);
    expect(eventStore.markEvents.mock.calls[0]?.[1]).toBe('failed');
    expect(eventStore.markEvents).toHaveBeenCalledWith(['123:Invoice:100:2026-08-22T00:00:00.000Z'], 'queued');
    vi.restoreAllMocks();
  });

  // GL#33: the consumer fetches every entity from the connected company, so a notification for a
  // different company (another realm connected to the same Intuit app) would sync whatever
  // record happens to share its id in ours.
  it('ignores notifications for a company other than the connected one', async () => {
    const eventStore = fakeEventStore();
    const queue = fakeQueue();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await post(eventStore, queue, notificationPayload, 'some-other-realm');

    expect(res.status).toBe(200);
    expect(eventStore.recordEvents).not.toHaveBeenCalled();
    expect(queue.sendBatch).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('realm "123"'));
    warnSpy.mockRestore();
  });

  it('keeps the matching notifications from a payload that mixes companies', async () => {
    const payload = {
      eventNotifications: [
        notificationPayload.eventNotifications[0],
        {
          realmId: '999',
          dataChangeEvent: {
            entities: [{ name: 'Customer', id: '61', operation: 'Update', lastUpdated: '2026-08-22T00:00:00.000Z' }],
          },
        },
      ],
    };
    const eventStore = fakeEventStore();
    const queue = fakeQueue();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await post(eventStore, queue, payload);

    expect(res.status).toBe(200);
    expect(sent(queue)).toEqual([{ direction: 'qb-to-monday', eventId: EVENT_ID }]);
    vi.restoreAllMocks();
  });

  // GL#33 review: a Delete used to be enqueued like an update; its fetch can only fail (Object Not
  // Found), so it burned retries into the DLQ. It is acknowledged and logged instead.
  it('acknowledges a Delete without recording or enqueueing it', async () => {
    const eventStore = fakeEventStore();
    const queue = fakeQueue();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await post(eventStore, queue, entities({ name: 'Invoice', id: '7', operation: 'Delete', lastUpdated: '2026-08-22T00:00:00.000Z' }));

    expect(res.status).toBe(200);
    expect(eventStore.recordEvents).not.toHaveBeenCalled();
    expect(queue.sendBatch).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Delete of invoice 7'));
    vi.restoreAllMocks();
  });

  it('syncs the survivor of a Merge like an update and logs the merged-away id', async () => {
    const eventStore = fakeEventStore();
    const queue = fakeQueue();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await post(eventStore, queue, entities({ name: 'Customer', id: '60', operation: 'Merge', lastUpdated: '2026-08-22T00:00:00.000Z', deletedId: '61' }));

    expect(res.status).toBe(200);
    expect(sent(queue)).toEqual([{ direction: 'qb-to-monday', eventId: EVENT_ID }]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('merged into customer 60'));
    vi.restoreAllMocks();
  });

  it('answers 503 (so Intuit redelivers) while no company is connected yet', async () => {
    const eventStore = fakeEventStore();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(eventStore, fakeQueue(), notificationPayload, null);

    expect(res.status).toBe(503);
    expect(eventStore.recordEvents).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

// The write switch (src/flags.ts): ingest runs in every mode; under `off` the queued message is
// stamped so the consumer dry-runs it even if the mode is flipped to `on` first.
describe('createQbWebhookApp — write switch', () => {
  async function postWithMode(mode: 'on' | 'hold' | 'off' | 'unknown') {
    const queue = fakeQueue();
    const app = createQbWebhookApp({
      qbEventStore: fakeEventStore(),
      queue,
      verifierToken,
      connectedRealmId: async () => '123',
      writeMode: async () => mode,
    });
    const { body, signature } = await signedBody(notificationPayload);
    const res = await app.request('/webhooks/quickbooks', { method: 'POST', body, headers: { 'intuit-signature': signature } });
    return { res, queue };
  }

  it("stamps the message 'dropped' under off", async () => {
    const { res, queue } = await postWithMode('off');
    expect(res.status).toBe(200);
    expect(sent(queue)).toEqual([{ direction: 'qb-to-monday', eventId: EVENT_ID, writeStamp: 'dropped' }]);
  });

  it.each(['on', 'hold', 'unknown'] as const)('leaves the message unstamped under %s', async (mode) => {
    const { queue } = await postWithMode(mode);
    expect(sent(queue)).toEqual([{ direction: 'qb-to-monday', eventId: EVENT_ID }]);
  });
});
