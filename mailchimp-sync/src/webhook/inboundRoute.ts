import { Hono } from 'hono';
import type { PendingInboundStore } from '../db/pendingInbound';
import { validateMailchimpWebhookBody } from './validateMailchimp';
import type { InboundSyncMessage } from '../types';

export interface InboundQueueLike {
  send(message: InboundSyncMessage): Promise<void>;
}

export interface InboundAppDeps {
  pendingStore: PendingInboundStore;
  queue: InboundQueueLike;
  // Mailchimp Marketing webhooks aren't cryptographically signed either — same
  // shared-secret-in-URL convention as the Monday side. Fails closed: an unset or
  // empty binding 401s every delivery rather than disabling the check.
  webhookSecret: string;
}

export function createInboundApp(deps: InboundAppDeps) {
  const app = new Hono();

  // Mailchimp pings the webhook URL with GET when it's first configured, expecting 200.
  app.get('/webhooks/mailchimp/audience', (c) => c.json({ ok: true }));

  app.post('/webhooks/mailchimp/audience', async (c) => {
    if (!deps.webhookSecret || c.req.query('secret') !== deps.webhookSecret) {
      return c.json({ ok: false }, 401);
    }

    let params: URLSearchParams;
    try {
      const formData = await c.req.formData();
      params = new URLSearchParams();
      for (const [key, value] of formData.entries()) {
        if (typeof value === 'string') params.append(key, value);
      }
    } catch {
      return c.json({ ok: false, error: 'invalid form body' }, 200);
    }

    let contactEvent;
    try {
      contactEvent = validateMailchimpWebhookBody(params);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync inbound webhook: rejected delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    await deps.pendingStore.upsertPending(contactEvent.email, new Date().toISOString());

    try {
      await deps.queue.send({ email: contactEvent.email });
      await deps.pendingStore.updateStatus(contactEvent.email, 'queued');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync inbound webhook: enqueue failed for "${contactEvent.email}": ${errMsg}`);
      await deps.pendingStore.updateStatus(contactEvent.email, 'failed', errMsg);
      return c.json({ ok: false }, 500);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
