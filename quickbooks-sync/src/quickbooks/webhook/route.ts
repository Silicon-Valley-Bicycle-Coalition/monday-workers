import { Hono } from 'hono';
import type { QbEventStore } from '../../db/qbEvents';
import type { QueueMessage, SyncStatus } from '../../types';
import type { QuickBooksClient } from '../client';
import { parseQbNotifications, verifyQbSignature } from './validate';

// Statuses that prove an event actually reached the queue. Anything else on an existing row
// means the row was inserted but the Worker died (CPU limit, timeout, throw) before enqueueing,
// so the change never made it downstream — those rows are resumed rather than skipped.
const REACHED_QUEUE_STATUSES: readonly SyncStatus[] = ['queued', 'written'];

export function hasReachedQueue(status: SyncStatus): boolean {
  return REACHED_QUEUE_STATUSES.includes(status);
}

export interface QueueLike {
  send(message: QueueMessage): Promise<void>;
}

export interface QbWebhookDeps {
  qbEventStore: QbEventStore;
  quickBooksClient: QuickBooksClient;
  queue: QueueLike;
  verifierToken: string;
}

export function createQbWebhookApp(deps: QbWebhookDeps) {
  const app = new Hono();

  app.post('/webhooks/quickbooks', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('intuit-signature');
    const valid = await verifyQbSignature(rawBody, signature, deps.verifierToken);
    if (!valid) {
      return c.body(null, 401);
    }

    let notifications;
    try {
      notifications = parseQbNotifications(JSON.parse(rawBody));
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 200);
    }

    for (const notification of notifications) {
      const insertResult = await deps.qbEventStore.insertEvent({
        eventId: notification.eventId,
        entityType: notification.entityType,
        qbId: notification.qbId,
        receivedAt: new Date().toISOString(),
      });

      if (insertResult === 'duplicate') {
        // "A row already exists" is not the same as "this was already processed" — see
        // hasReachedQueue. Only skip when the existing row genuinely reached the queue,
        // otherwise fall through and resume it using the row that's already there.
        const existing = await deps.qbEventStore.getEvent(notification.eventId);
        if (existing === null || hasReachedQueue(existing.status)) continue;
      }

      try {
        const record = await deps.quickBooksClient.getEntity(notification.entityType, notification.qbId);
        await deps.qbEventStore.updateStatus(notification.eventId, 'fetched', {
          fetchedPayload: JSON.stringify(record),
        });
        await deps.queue.send({ direction: 'qb-to-monday', eventId: notification.eventId });
        await deps.qbEventStore.updateStatus(notification.eventId, 'queued');
      } catch (err) {
        await deps.qbEventStore.updateStatus(notification.eventId, 'failed', {
          error: (err as Error).message,
        });
      }
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
