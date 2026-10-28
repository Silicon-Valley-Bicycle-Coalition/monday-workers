import { Hono } from 'hono';
import type { MapStore } from '../../db/map';
import type { MondayEventStore } from '../../db/mondayEvents';
import { stampFor, type WriteMode } from '../../flags';
import type { QuickbooksSyncConfig } from '../../types';
import { hasReachedQueue, type QueueLike } from '../../quickbooks/webhook/route';
import { isChallengeRequest, validateMondayEvent } from './validate';

export interface MondayWebhookDeps {
  mondayEventStore: MondayEventStore;
  mapStore: MapStore;
  queue: QueueLike;
  config: QuickbooksSyncConfig;
  // Monday doesn't sign webhook payloads — the mitigation is a shared secret embedded in the
  // webhook URL at subscription time (`?secret=...`), checked here. Same pattern as
  // mailchimp-sync's Monday webhook, but fail-closed: an unset or empty binding rejects every
  // delivery rather than disabling the check.
  mondayWebhookSecret: string;
  // The write switch's mode (flags.ts readWriteMode), read once per accepted delivery. Ingest runs
  // in every mode; under `off` the message is stamped so the consumer dry-runs it.
  writeMode: () => Promise<WriteMode>;
}

export function createMondayWebhookApp(deps: MondayWebhookDeps) {
  const app = new Hono();

  app.post('/webhooks/monday', async (c) => {
    // Auth first — even the one-time challenge handshake stays behind the secret, since the
    // secret is part of the URL Monday registers and so arrives with the challenge too. An
    // unauthenticated caller learns nothing and enqueues nothing.
    if (!deps.mondayWebhookSecret || c.req.query('secret') !== deps.mondayWebhookSecret) {
      return c.json({ ok: false }, 401);
    }

    // Read the body as text and parse it ourselves so a malformed payload — something that will
    // never parse no matter how often it's redelivered — returns a recorded error at HTTP 200
    // rather than crashing the request with an unhandled 500.
    const rawBody = await c.req.text();

    let event;
    try {
      const body = JSON.parse(rawBody);
      if (isChallengeRequest(body)) {
        return c.json({ challenge: body.challenge }, 200);
      }
      event = validateMondayEvent(body);
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 200);
    }

    if (event.boardId !== deps.config.monday.boards.customers) {
      return c.json({ ok: true, ignored: true }, 200);
    }

    const existing = await deps.mapStore.getByMondayItemId('customer', event.mondayItemId);
    if (existing !== null) {
      return c.json({ ok: true, alreadyLinked: true }, 200);
    }

    const insertResult = await deps.mondayEventStore.insertEvent({
      eventId: event.mondayItemId,
      mondayItemId: event.mondayItemId,
      rawPayload: JSON.stringify(event.columnValues),
      receivedAt: new Date().toISOString(),
    });

    // "A row already exists" is not the same as "this was already processed" — see
    // hasReachedQueue. Only skip when the existing row genuinely reached the queue, otherwise
    // resume it (there's no fetch step on the Monday side, so that just means enqueueing).
    let resumed = false;
    if (insertResult === 'duplicate') {
      const existing = await deps.mondayEventStore.getEvent(event.mondayItemId);
      if (existing === null || hasReachedQueue(existing.status)) {
        return c.json({ ok: true, duplicate: true }, 200);
      }
      resumed = true;
    }

    const stamp = stampFor(await deps.writeMode());
    try {
      await deps.queue.send({ direction: 'monday-to-qb', eventId: event.mondayItemId, ...stamp });
      await deps.mondayEventStore.updateStatus(event.mondayItemId, 'queued');
    } catch (err) {
      const errMsg = (err as Error).message;
      console.error(`quickbooks-sync monday webhook: enqueue failed for item "${event.mondayItemId}": ${errMsg}`);
      await deps.mondayEventStore.updateStatus(event.mondayItemId, 'failed', { error: errMsg });
      // A 5xx makes Monday redeliver — create_pulse fires once per item, so a 200 here would
      // strand the customer forever. The 'failed' row (not hasReachedQueue) is what lets the
      // redelivery take the resume branch above and re-enqueue idempotently.
      return c.json({ ok: false }, 500);
    }

    return c.json({ ok: true, resumed }, 200);
  });

  return app;
}
