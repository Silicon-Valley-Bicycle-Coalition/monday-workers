import { Hono } from 'hono';
import type { PendingStore } from '../db/pending';
import { validateWebhookBody } from './validate';
import type { RecomputeQueueMessage } from '../types';

export interface QueueLike {
  send(message: RecomputeQueueMessage): Promise<void>;
}

export interface AppDeps {
  pendingStore: PendingStore;
  queue: QueueLike;
  // Monday doesn't sign webhook payloads (no HMAC header to verify) — the standard
  // mitigation is a shared secret embedded in the webhook URL itself, set when
  // subscribing (e.g. .../webhooks/monday/donations?secret=...) and checked here.
  // undefined/empty disables the check — never do that outside local dev.
  webhookSecret?: string;
}

// Ingest-and-enqueue only, same division of labor as every other webhook-driven
// Worker in this monorepo: resolving the owner and writing to Monday both happen in
// the queue consumer, where a transient failure gets retries and a dead-letter queue
// instead of dying inside the webhook request (see root README's Reliability section).
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/webhooks/monday/donations', async (c) => {
    if (deps.webhookSecret && c.req.query('secret') !== deps.webhookSecret) {
      return c.json({ ok: false }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 200);
    }

    // Monday's webhook-subscription verification handshake: echo the challenge back
    // verbatim, no other processing. Sent once, at subscription-creation time.
    if (typeof body === 'object' && body !== null && 'challenge' in body) {
      return c.json({ challenge: (body as { challenge: unknown }).challenge }, 200);
    }

    let donationEvent;
    try {
      donationEvent = validateWebhookBody(body);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donation-rollups webhook: rejected delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    await deps.pendingStore.upsertPending({
      donationItemId: donationEvent.donationItemId,
      donationBoardId: donationEvent.boardId,
      eventId: donationEvent.eventId,
      receivedAt: new Date().toISOString(),
    });

    try {
      await deps.queue.send({ donationItemId: donationEvent.donationItemId, donationBoardId: donationEvent.boardId });
      await deps.pendingStore.updateStatus(donationEvent.donationItemId, 'queued');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donation-rollups webhook: enqueue failed for donation "${donationEvent.donationItemId}": ${errMsg}`);
      await deps.pendingStore.updateStatus(donationEvent.donationItemId, 'failed', { error: errMsg });
      // A 5xx gives Monday the chance to redeliver; upserting by donation id makes a
      // redelivery safe either way.
      return c.json({ ok: false }, 500);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
