import { Hono } from 'hono';
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';
import { validateEnvelope } from './validate';
import { matchDonor } from '../matching/donors';
import { errorMessage } from '../util/errorMessage';
import type { FunraiseQueueMessage } from '../consumer/processBatch';

export interface QueueLike {
  send(message: FunraiseQueueMessage): Promise<void>;
}

export interface AppDeps {
  eventStore: EventStore;
  mondayClient: MondayClient;
  config: FunraiseSyncConfig;
  queue: QueueLike;
}

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
      return c.json({ ok: false, error: errorMessage(err) }, 200);
    }

    const insertResult = await deps.eventStore.insertEvent({
      eventId: envelope.eventId,
      entityType: envelope.entityType,
      rawPayload: JSON.stringify(envelope.raw),
      receivedAt: new Date().toISOString(),
    });

    if (insertResult === 'duplicate') {
      return c.json({ ok: true, duplicate: true }, 200);
    }

    try {
      const match = await matchDonor(deps.mondayClient, deps.config, envelope.raw);
      await deps.eventStore.updateStatus(envelope.eventId, 'matched', {
        matchedDonorItemId: match.donorItemId,
      });
      await deps.queue.send({ eventId: envelope.eventId });
      await deps.eventStore.updateStatus(envelope.eventId, 'queued');
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`funraise-sync webhook: donor match/enqueue failed for event "${envelope.eventId}": ${errMsg}`);
      await deps.eventStore.updateStatus(envelope.eventId, 'failed', {
        error: errMsg,
      });
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
