import { Hono } from 'hono';
import type { OrderStore } from '../db/orders';
import type { EventbriteSyncConfig } from '../types';
import { validateDelivery } from './validate';
import { errorMessage } from '../util/errorMessage';
import type { OrderQueueMessage } from '../consumer/processBatch';
import { stampFor, type WriteMode } from '../flags';

// Header form of the shared secret, for callers that can set one (scripts/backfill-orders.mjs,
// a hand replay). Eventbrite itself cannot: its webhook form takes only a target URL and the
// actions (API blueprint, Create Webhook), so its deliveries keep `?secret=`.
export const SECRET_HEADER = 'X-Webhook-Secret';

/**
 * Constant-time comparison of a presented secret against the configured one (funraise-sync
 * #25, copied). Both sides are hashed to fixed-length SHA-256 digests first, so neither the
 * content nor the length of the real secret leaks through timing, then every digest byte is
 * compared with no early exit. A missing value on either side never matches.
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
  send(message: OrderQueueMessage): Promise<void>;
}

export interface AppDeps {
  orderStore: OrderStore;
  config: EventbriteSyncConfig;
  queue: QueueLike;
  // Eventbrite documents no signature or verification handshake for webhook deliveries, so
  // the mitigation is a shared secret embedded in the registered webhook URL (`?secret=...`)
  // or, for our own tooling, the X-Webhook-Secret header; checked in constant time on every
  // POST. Fails closed: when unset, every delivery is rejected with 401 rather than accepted
  // blind — this endpoint ends up writing the live Donations board.
  webhookSecret: string | undefined;
  // The write switch's mode (flags.ts readWriteMode), read once per accepted delivery. Ingest runs
  // in every mode; under `off` the message is stamped so the consumer dry-runs it.
  writeMode: () => Promise<WriteMode>;
}

// The handler only authenticates, validates, records, and enqueues. The Eventbrite fetch, donor
// matching and the Monday write all live in the queue consumer, where failures get retries and
// a dead-letter queue instead of dying inside a webhook request.
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  // The registered URL. One organization-wide webhook with the three order actions.
  app.post('/webhooks/eventbrite/order', async (c) => {
    const presented = c.req.header(SECRET_HEADER) ?? c.req.query('secret');
    if (!(await secretsMatch(presented, deps.webhookSecret))) {
      return c.json({ ok: false }, 401);
    }

    let verdict;
    try {
      verdict = validateDelivery(await c.req.json(), deps.config);
    } catch (err) {
      // 200, not 4xx: Eventbrite retries non-2xx answers, and a malformed payload won't get
      // better. This log line is where a payload-shape change becomes visible.
      const errMsg = errorMessage(err);
      console.error(`eventbrite-sync webhook: rejected delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }
    if (verdict.kind === 'ignore') {
      console.warn(`eventbrite-sync webhook: ignored delivery: ${verdict.reason}`);
      return c.json({ ok: true, ignored: verdict.reason }, 200);
    }

    const { orderId, action } = verdict.delivery;
    await deps.orderStore.recordDelivery({ orderId, action, receivedAt: new Date().toISOString() });

    // Every delivery is enqueued, redeliveries included: the consumer re-fetches the order and
    // writes idempotently, so a duplicate costs one fetch and never a second item. Swallowing
    // "duplicates" would need a delivery id Eventbrite doesn't send.
    try {
      const mode = await deps.writeMode();
      await deps.queue.send({ orderId, action, ...stampFor(mode) });
      await deps.orderStore.updateStatus(orderId, 'queued');
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`eventbrite-sync webhook: enqueue failed for order "${orderId}": ${errMsg}`);
      await deps.orderStore.updateStatus(orderId, 'failed', { error: errMsg });
      // A 5xx gives Eventbrite the chance to redeliver; the keyed upsert makes that safe.
      return c.json({ ok: false }, 500);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
