import { Hono } from 'hono';
import type { QbEventStore } from '../../db/qbEvents';
import { stampFor, type WriteMode } from '../../flags';
import type { QueueMessage, SyncStatus } from '../../types';
import { parseQbNotifications, verifyQbSignature } from './validate';

// Statuses that prove an event actually reached the queue. Anything else on an existing row
// means the row was inserted but the Worker died (CPU limit, timeout, throw) before enqueueing,
// or the enqueue failed, so the change never made it downstream — those rows are resumed rather
// than skipped.
const REACHED_QUEUE_STATUSES: readonly SyncStatus[] = ['queued', 'written'];

export function hasReachedQueue(status: SyncStatus): boolean {
  return REACHED_QUEUE_STATUSES.includes(status);
}

export interface QueueLike {
  send(message: QueueMessage): Promise<void>;
}

export interface QbWebhookDeps {
  qbEventStore: QbEventStore;
  queue: QueueLike;
  verifierToken: string;
  // The realm (company) id of the connected QuickBooks company — the one the stored OAuth tokens
  // belong to — or null before the initial handshake. Read-only: never refreshes a token.
  connectedRealmId: () => Promise<string | null>;
  // The write switch's mode (flags.ts readWriteMode), read once per accepted delivery. Ingest runs
  // in every mode; under `off` the message is stamped so the consumer dry-runs it.
  writeMode: () => Promise<WriteMode>;
}

// The webhook only records and enqueues (#33). It used to fetch the changed entity from
// QuickBooks inline and answer 200 even when that fetch failed, so Intuit never redelivered and
// nothing else resumed the row — the change was silently lost. The fetch now happens in the
// queue consumer, which has retries with backoff and a DLQ behind it, reads the entity as of
// processing time (not as of the webhook), and is the only code path that needs an OAuth token.
// This route never touches QuickBooks, which also keeps it inside Intuit's 3-second response
// window.
//
// A failed enqueue answers 500: Intuit retries non-200 deliveries, and the row left 'failed'
// (not hasReachedQueue) takes the resume branch on the redelivery.
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

    if (notifications.length === 0) return c.json({ ok: true }, 200);

    // A valid signature proves the payload came from Intuit for this app, not that it's about
    // this company: an app connected to several companies gets notifications for all of them.
    // The consumer fetches every entity from the connected company by id, so a foreign
    // notification would sync an unrelated record that happens to share the id (#33).
    const realmId = await deps.connectedRealmId();
    if (realmId === null) {
      console.error('quickbooks-sync qb webhook: no QuickBooks company connected yet (qb_oauth_tokens is empty) — asking Intuit to redeliver');
      return c.json({ ok: false }, 503);
    }

    const stamp = stampFor(await deps.writeMode());
    let enqueueFailed = false;
    for (const notification of notifications) {
      if (notification.realmId !== realmId) {
        console.warn(`quickbooks-sync qb webhook: ignoring notification for realm "${notification.realmId}" (connected company is another realm)`);
        continue;
      }
      // Delete (#33 review): the record is gone, so the consumer's fetch could only fail and
      // dead-letter. Acknowledge and log it; the Monday item is deliberately left in place for
      // staff to archive (README "Deletes and merges") rather than deleted by a webhook.
      if (notification.operation === 'Delete') {
        console.log(`quickbooks-sync qb webhook: QuickBooks Delete of ${notification.entityType} ${notification.qbId} — not synced; its Monday item (if any) is left in place`);
        continue;
      }
      // Merge: `qbId` is the survivor and is synced like an update below; the merged-away record's
      // Monday item and mapping are left in place for staff to reconcile.
      if (notification.operation === 'Merge' && notification.deletedId !== null) {
        console.log(`quickbooks-sync qb webhook: QuickBooks ${notification.entityType} ${notification.deletedId} merged into ${notification.entityType} ${notification.qbId} — syncing the survivor; the merged-away item is left in place`);
      }

      const insertResult = await deps.qbEventStore.insertEvent({
        eventId: notification.eventId,
        entityType: notification.entityType,
        qbId: notification.qbId,
        receivedAt: new Date().toISOString(),
      });

      if (insertResult === 'duplicate') {
        // "A row already exists" is not the same as "this was already processed" — see
        // hasReachedQueue. Only skip when the existing row genuinely reached the queue,
        // otherwise fall through and resume it.
        const existing = await deps.qbEventStore.getEvent(notification.eventId);
        if (existing === null || hasReachedQueue(existing.status)) continue;
      }

      try {
        await deps.queue.send({ direction: 'qb-to-monday', eventId: notification.eventId, ...stamp });
        await deps.qbEventStore.updateStatus(notification.eventId, 'queued');
      } catch (err) {
        // Keep going: the other notifications in this payload can still be enqueued, and the
        // redelivery skips whichever of them reached the queue.
        enqueueFailed = true;
        const errMsg = (err as Error).message;
        console.error(`quickbooks-sync qb webhook: enqueue failed for "${notification.eventId}": ${errMsg}`);
        await deps.qbEventStore.updateStatus(notification.eventId, 'failed', { error: errMsg });
      }
    }

    if (enqueueFailed) return c.json({ ok: false }, 500);
    return c.json({ ok: true }, 200);
  });

  return app;
}
