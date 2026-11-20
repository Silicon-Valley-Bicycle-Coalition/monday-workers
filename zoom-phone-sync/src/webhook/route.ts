import { Hono } from 'hono';
import type { EventStore, PhoneQueueMessage } from '../db/events';
import { stampFor, type WriteMode } from '../flags';
import type { ZoomPhoneSyncConfig } from '../types';
import { hmacHex, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from './signature';
import { isSubscribedEvent, parseDelivery, type SkipReason } from './parse';

export const WEBHOOK_PATH = '/webhooks/zoom';

export interface QueueLike {
  sendBatch(messages: PhoneQueueMessage[]): Promise<void>;
}

export interface AppDeps {
  eventStore: EventStore;
  config: ZoomPhoneSyncConfig;
  queue: QueueLike;
  // ZOOM_WEBHOOK_SECRET. Unset fails closed: every delivery gets 401.
  webhookSecret: string | undefined;
  // The write switch, read once per delivery that has something to enqueue. Ingest runs in every
  // mode; under `off` messages are stamped so the consumer dry-runs them.
  writeMode: () => Promise<WriteMode>;
  now?: () => number;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Every log line here is counts and event names only: never a phone number, name, email or text.
function log(message: string): void {
  console.log(`zoom-phone-sync webhook: ${message}`);
}

function skipSummary(skipped: Record<SkipReason, number>): string {
  return `internal ${skipped.internal}, excluded ${skipped.excluded}, no external number ${skipped.noExternalNumber}, malformed ${skipped.malformed}`;
}

// The handler only verifies, filters, writes D1 and enqueues: Zoom wants an answer within 3
// seconds. Matching and the Monday write are the queue consumer's (#54).
export function createApp(deps: AppDeps) {
  const app = new Hono();
  const now = deps.now ?? Date.now;

  app.get('/health', (c) => c.json({ ok: true }));

  app.post(WEBHOOK_PATH, async (c) => {
    const rawBody = await c.req.text();

    // Verified before anything else, the URL validation included: answering an unsigned
    // validation would hand out HMAC(secret, any string), and with plainToken set to
    // "v0:{ts}:{body}" that is a valid signature for a forged delivery.
    const check = await verifySignature(
      deps.webhookSecret,
      { signature: c.req.header(SIGNATURE_HEADER), timestamp: c.req.header(TIMESTAMP_HEADER) },
      rawBody,
      now(),
    );
    if (check !== 'ok') {
      log(`rejected delivery (signature ${check})`);
      return c.json({ ok: false }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      log('rejected delivery (body is not JSON)');
      return c.json({ ok: false }, 400);
    }
    if (!isObject(body)) {
      log('rejected delivery (body is not an object)');
      return c.json({ ok: false }, 400);
    }
    const event = body.event;
    const payload = isObject(body.payload) ? body.payload : null;

    if (event === 'endpoint.url_validation') {
      const plainToken = payload?.plainToken;
      if (typeof plainToken !== 'string' || plainToken === '') return c.json({ ok: false }, 400);
      log('answered endpoint.url_validation');
      return c.json({ plainToken, encryptedToken: await hmacHex(deps.webhookSecret!, plainToken) }, 200);
    }

    // 200 for anything we don't handle: Zoom needs no retry, and nothing is stored.
    if (!isSubscribedEvent(event)) {
      log(`ignored ${typeof event === 'string' ? event : 'an event with no name'} (not subscribed)`);
      return c.json({ ok: true, ignored: true }, 200);
    }
    const { accountId } = deps.config.zoom;
    if (accountId !== null && payload?.account_id !== accountId) {
      log(`ignored ${event} (another Zoom account)`);
      return c.json({ ok: true, ignored: true }, 200);
    }

    const { events, skipped } = parseDelivery(event, payload, deps.config);
    const receivedAt = new Date(now()).toISOString();
    const toEnqueue: string[] = [];
    let duplicates = 0;
    for (const phoneEvent of events) {
      const result = await deps.eventStore.insertEvent(phoneEvent, receivedAt);
      if (result === 'duplicate') duplicates += 1;
      else toEnqueue.push(phoneEvent.eventId);
    }

    if (toEnqueue.length > 0) {
      try {
        const stamp = stampFor(await deps.writeMode());
        await deps.queue.sendBatch(toEnqueue.map((eventId) => ({ eventId, ...stamp })));
      } catch (err) {
        // The rows stay pending with no enqueued_at, so Zoom's retry (5xx is retried) re-enqueues them.
        log(`${event}: enqueue failed for ${toEnqueue.length} event(s): ${err instanceof Error ? err.message : String(err)}`);
        return c.json({ ok: false }, 500);
      }
      const enqueuedAt = new Date(now()).toISOString();
      for (const eventId of toEnqueue) await deps.eventStore.markEnqueued(eventId, enqueuedAt);
    }

    log(`${event}: enqueued ${toEnqueue.length}, duplicates ${duplicates}; skipped ${skipSummary(skipped)}`);
    return c.json({ ok: true }, 200);
  });

  return app;
}
