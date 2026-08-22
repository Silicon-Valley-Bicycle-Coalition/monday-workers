import { Hono } from 'hono';
import type { MapStore } from '../../db/map';
import type { MondayEventStore } from '../../db/mondayEvents';
import type { QuickbooksSyncConfig } from '../../types';
import type { QueueLike } from '../../quickbooks/webhook/route';
import { isChallengeRequest, validateMondayEvent } from './validate';

export interface MondayWebhookDeps {
  mondayEventStore: MondayEventStore;
  mapStore: MapStore;
  queue: QueueLike;
  config: QuickbooksSyncConfig;
}

export function createMondayWebhookApp(deps: MondayWebhookDeps) {
  const app = new Hono();

  app.post('/webhooks/monday', async (c) => {
    const body = await c.req.json();

    if (isChallengeRequest(body)) {
      return c.json({ challenge: body.challenge }, 200);
    }

    let event;
    try {
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

    if (insertResult === 'duplicate') {
      return c.json({ ok: true, duplicate: true }, 200);
    }

    try {
      await deps.queue.send({ direction: 'monday-to-qb', eventId: event.mondayItemId });
      await deps.mondayEventStore.updateStatus(event.mondayItemId, 'queued');
    } catch (err) {
      await deps.mondayEventStore.updateStatus(event.mondayItemId, 'failed', {
        error: (err as Error).message,
      });
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
