import { Hono } from 'hono';
import type { PendingOutboundStore } from '../db/pendingOutbound';
import { validateMondayWebhookBody } from './validateMonday';
import type { Config, OutboundSyncMessage } from '../types';

export interface OutboundQueueLike {
  send(message: OutboundSyncMessage): Promise<void>;
}

export interface OutboundAppDeps {
  pendingStore: PendingOutboundStore;
  queue: OutboundQueueLike;
  // Monday doesn't sign webhook payloads — the mitigation is a shared secret embedded
  // in the webhook URL at subscription time, checked here. Fails closed: an unset or
  // empty binding 401s every delivery rather than disabling the check.
  webhookSecret: string;
  // Needed to recognize and skip this Worker's own self-inflicted events: the inbound
  // consumer writes to config.monday.columns.mailchimpCampaigns on this same Donors board,
  // which would otherwise re-trigger this webhook and risk a feedback loop with Mailchimp.
  config: Config;
}

// Ingest-and-enqueue only — resolving the Donor's current columns and writing to
// Mailchimp both happen in the queue consumer (src/consumer/outbound.ts), where a
// transient failure gets retries and a dead-letter queue.
export function createOutboundApp(deps: OutboundAppDeps) {
  const app = new Hono();

  app.post('/webhooks/monday/donors', async (c) => {
    // Auth first — even the one-time challenge handshake stays behind the secret, since the
    // secret is part of the URL Monday registers and so arrives with the challenge too. An
    // unauthenticated caller learns nothing and enqueues nothing.
    if (!deps.webhookSecret || c.req.query('secret') !== deps.webhookSecret) {
      return c.json({ ok: false }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 200);
    }

    // Monday's webhook-subscription verification handshake: echo the challenge back
    // verbatim, sent once at subscription-creation time.
    if (typeof body === 'object' && body !== null && 'challenge' in body) {
      return c.json({ challenge: (body as { challenge: unknown }).challenge }, 200);
    }

    let donorEvent;
    try {
      donorEvent = validateMondayWebhookBody(body);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync outbound webhook: rejected delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    // Self-inflicted event: the inbound consumer's own write to the mailchimpCampaigns
    // connect-column just triggered this webhook. Not an error — skip without enqueueing to
    // avoid an outbound→Mailchimp→inbound feedback loop.
    if (donorEvent.columnId !== undefined && donorEvent.columnId === deps.config.monday.columns.mailchimpCampaigns) {
      return c.json({ ok: true, skipped: true }, 200);
    }

    await deps.pendingStore.upsertPending(donorEvent.donorItemId, new Date().toISOString());

    try {
      await deps.queue.send({ donorItemId: donorEvent.donorItemId });
      await deps.pendingStore.updateStatus(donorEvent.donorItemId, 'queued');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync outbound webhook: enqueue failed for donor "${donorEvent.donorItemId}": ${errMsg}`);
      await deps.pendingStore.updateStatus(donorEvent.donorItemId, 'failed', errMsg);
      // A 5xx gives Monday the chance to redeliver; upserting by donor id makes a
      // redelivery safe either way.
      return c.json({ ok: false }, 500);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
