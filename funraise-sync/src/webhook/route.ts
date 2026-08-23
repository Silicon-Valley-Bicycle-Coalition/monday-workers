import { Hono } from 'hono';
import type { EventStore } from '../db/events';
import type { FunraiseSyncConfig } from '../types';
import { validateEnvelope, extractEntityId } from './validate';
import { stripDenylistedFields } from '../util/stripFields';
import { errorMessage } from '../util/errorMessage';
import type { FunraiseQueueMessage } from '../consumer/processBatch';

export interface QueueLike {
  send(message: FunraiseQueueMessage): Promise<void>;
}

export interface AppDeps {
  eventStore: EventStore;
  config: FunraiseSyncConfig;
  queue: QueueLike;
}

// The handler only validates, ingests, and enqueues. Donor matching and the
// Monday write both live in the queue consumer, where failures get retries
// and a dead-letter queue instead of dying inside a webhook request.
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/webhooks/funraise/:entityType', async (c) => {
    const incomingSecret = c.req.header('x-hook-secret');
    if (incomingSecret) {
      c.header('x-hook-secret', incomingSecret);
      return c.body(null, 200);
    }

    const entityTypeParam = c.req.param('entityType');
    let envelope;
    try {
      const body = await c.req.json();
      envelope = validateEnvelope(entityTypeParam, body);
    } catch (err) {
      // Funraise ignores the response body, so this log line is the only place a
      // payload-shape change (renamed id field, new entity type) becomes visible.
      const errMsg = errorMessage(err);
      console.error(`funraise-sync webhook: rejected ${entityTypeParam} delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    const entityId = extractEntityId(envelope, deps.config);
    const stripped = stripDenylistedFields(envelope.raw, deps.config.funraiseSync.doNotMigrateFields);

    const upsertResult = await deps.eventStore.upsertEvent({
      eventId: envelope.eventId,
      entityType: envelope.entityType,
      entityId,
      rawPayload: JSON.stringify(stripped),
      receivedAt: new Date().toISOString(),
    });

    if (upsertResult === 'duplicate') {
      // An exact redelivery is only a no-op if the original delivery actually made it
      // into the queue. A row stuck at 'failed' (enqueue threw, we returned 5xx) or
      // 'received' (crashed between insert and send) is stranded — this redelivery is
      // its recovery path, so fall through and enqueue it.
      const existing = await deps.eventStore.getEventByEntity(envelope.entityType, entityId);
      if (existing === null || (existing.status !== 'failed' && existing.status !== 'received')) {
        return c.json({ ok: true, duplicate: true }, 200);
      }
    }

    try {
      await deps.queue.send({ entityType: envelope.entityType, entityId });
      await deps.eventStore.updateStatusByEntity(envelope.entityType, entityId, 'queued');
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`funraise-sync webhook: enqueue failed for ${envelope.entityType} "${entityId}": ${errMsg}`);
      await deps.eventStore.updateStatusByEntity(envelope.entityType, entityId, 'failed', {
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
