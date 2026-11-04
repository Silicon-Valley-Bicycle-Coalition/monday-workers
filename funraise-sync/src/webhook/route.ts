import { Hono } from 'hono';
import type { EventStore } from '../db/events';
import type { EntityType, FunraiseSyncConfig } from '../types';
import { validateEnvelope, extractEntityId } from './validate';
import { stripDenylistedFields } from '../util/stripFields';
import { errorMessage } from '../util/errorMessage';
import type { FunraiseQueueMessage } from '../consumer/processBatch';
import { stampFor, type WriteMode } from '../flags';

const ENTITY_TYPE: EntityType = 'transaction';

// Header form of the shared secret, for callers that can set one (scripts/redrive-failed.mjs, a
// hand replay). Funraise itself cannot: its webhook config is only a target URL and a contact
// email (help.funraise.io "Webhooks", checked 2026-09-25), so its deliveries keep `?secret=`.
export const SECRET_HEADER = 'X-Webhook-Secret';

/**
 * Constant-time comparison of a presented secret against the configured one (#25). Both sides
 * are hashed to fixed-length SHA-256 digests first, so neither the content nor the length of the
 * real secret leaks through timing, then every digest byte is compared with no early exit.
 * (Hand-rolled rather than workerd's crypto.subtle.timingSafeEqual only because this project's
 * tsconfig resolves the global `crypto` to the DOM typing, which lacks it.) A missing value on
 * either side never matches.
 */
export async function secretsMatch(presented: string | undefined, expected: string | undefined): Promise<boolean> {
  if (presented === undefined || expected === undefined || expected === '') return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export interface QueueLike {
  send(message: FunraiseQueueMessage): Promise<void>;
}

export interface AppDeps {
  eventStore: EventStore;
  config: FunraiseSyncConfig;
  queue: QueueLike;
  // Funraise webhook deliveries carry no per-event signature we can rely on, so the
  // mitigation is a shared secret embedded in the registered webhook URL
  // (`?secret=...`) — Funraise can't send custom headers — or, for our own tooling, the
  // X-Webhook-Secret header; checked in constant time on every POST. Fails closed: when
  // unset (secret not yet provisioned), every delivery is rejected with 401 rather than
  // accepted blind — this endpoint writes to the live Donations board.
  webhookSecret: string | undefined;
  // The write switch's mode (flags.ts readWriteMode), read once per accepted delivery. Ingest runs
  // in every mode; under `off` the message is stamped so the consumer dry-runs it.
  writeMode: () => Promise<WriteMode>;
}

// The handler only validates, ingests, and enqueues. Donor matching and the
// Monday write both live in the queue consumer, where failures get retries
// and a dead-letter queue instead of dying inside a webhook request.
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  // Funraise has one webhook per organization and it fires only for transactions (decided
  // 2026-09-18; see README "Recurring gifts and registrations"). This is the registered URL.
  app.post('/webhooks/funraise/transaction', async (c) => {
    const presented = c.req.header(SECRET_HEADER) ?? c.req.query('secret');
    if (!(await secretsMatch(presented, deps.webhookSecret))) {
      return c.json({ ok: false }, 401);
    }

    const hookSecretHeader = c.req.header('x-hook-secret');
    let envelope;
    try {
      const body = await c.req.json();
      envelope = validateEnvelope(body);
    } catch (err) {
      // REST-Hooks subscribe handshake: echo x-hook-secret back — but only for a
      // body that isn't a real event (empty or non-event shape). A valid event is
      // processed below even when the header is present, so a per-delivery secret
      // can never swallow real deliveries.
      if (hookSecretHeader) {
        c.header('x-hook-secret', hookSecretHeader);
        return c.body(null, 200);
      }
      // Funraise ignores the response body, so this log line is the only place a
      // payload-shape change (renamed id field, new entity type) becomes visible.
      const errMsg = errorMessage(err);
      console.error(`funraise-sync webhook: rejected delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    const entityId = extractEntityId(envelope, deps.config);
    const stripped = stripDenylistedFields(envelope.raw, deps.config.funraiseSync.doNotMigrateFields);

    const upsertResult = await deps.eventStore.upsertEvent({
      eventId: envelope.eventId,
      sentAt: envelope.sentAt,
      entityType: ENTITY_TYPE,
      entityId,
      rawPayload: JSON.stringify(stripped),
      receivedAt: new Date().toISOString(),
    });

    if (upsertResult === 'duplicate') {
      // An exact redelivery is only a no-op if the original delivery actually made it
      // into the queue. A row stuck at 'failed' (enqueue threw, we returned 5xx) or
      // 'received' (crashed between insert and send) is stranded — this redelivery is
      // its recovery path, so fall through and enqueue it.
      const existing = await deps.eventStore.getEventByEntity(ENTITY_TYPE, entityId);
      if (existing === null || (existing.status !== 'failed' && existing.status !== 'received')) {
        return c.json({ ok: true, duplicate: true }, 200);
      }
    }

    try {
      const mode = await deps.writeMode();
      await deps.queue.send({ entityType: ENTITY_TYPE, entityId, ...stampFor(mode) });
      await deps.eventStore.updateStatusByEntity(ENTITY_TYPE, entityId, 'queued');
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`funraise-sync webhook: enqueue failed for ${ENTITY_TYPE} "${entityId}": ${errMsg}`);
      await deps.eventStore.updateStatusByEntity(ENTITY_TYPE, entityId, 'failed', {
        error: errMsg,
      });
      // A 5xx gives Funraise the chance to redeliver; the entity-keyed upsert
      // makes a redelivery safe either way.
      return c.json({ ok: false }, 500);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
