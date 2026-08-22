import { Hono } from 'hono';
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';
import { validateEnvelope } from './validate';
import { matchDonor } from '../matching/donors';

export interface QueueLike {
  send(message: { eventId: string }): Promise<void>;
}

export interface AppDeps {
  eventStore: EventStore;
  mondayClient: MondayClient;
  config: FunraiseSyncConfig;
  queue: QueueLike;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

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
      return c.json({ ok: false, error: (err as Error).message }, 200);
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
      await deps.eventStore.updateStatus(envelope.eventId, 'failed', {
        error: (err as Error).message,
      });
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
