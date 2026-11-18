import { Hono } from 'hono';
import type { OrderStore } from '../db/orders';
import type { EventStore } from '../db/events';
import type { AttendeeStore } from '../db/attendees';
import type { EventbriteSyncConfig } from '../types';
import { validateDelivery } from './validate';
import { validateAttendeeDelivery } from './validateAttendee';
import { errorMessage } from '../util/errorMessage';
import type { WriteQueueMessage } from '../consumer/processBatch';
import { stampFor, type WriteMode } from '../flags';
import type { ClassEmailStore } from '../db/classEmails';
import type { BatchSender } from '../util/sendBatch';
import type { MondayClient } from '../monday/client';
import { registerClassEmailRoutes } from '../classEmails/routes';

// Header form of the shared secret, for callers that can set one (scripts/backfill-orders.mjs,
// a hand replay). Eventbrite itself cannot: its webhook form takes only a target URL and the
// actions (API blueprint, Create Webhook), so its deliveries keep `?secret=`.
export const SECRET_HEADER = 'X-Webhook-Secret';

/**
 * Constant-time comparison of a presented secret against the configured one (funraise-sync
 * GL#25, copied). Both sides are hashed to fixed-length SHA-256 digests first, so neither the
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
  send(message: WriteQueueMessage): Promise<void>;
}

export interface AppDeps {
  orderStore: OrderStore;
  eventStore: EventStore;
  attendeeStore: AttendeeStore;
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
  // The class email send page's routes (src/classEmails/routes.ts). Optional only so the webhook
  // tests need not build them; the Worker always passes it, and the routes answer 401 to
  // everything while `secret` is unset. `mondayClient` is a function so a missing Monday binding
  // can't break the webhook routes, and it is called only after the secret has passed.
  classEmails?: {
    store: ClassEmailStore;
    mondayClient: () => MondayClient;
    secret: string | undefined;
    now?: () => Date;
    // The follow-up messages after a send (timeline entries, No Show, People links).
    queue: BatchSender<WriteQueueMessage>;
  };
}

// The handler only authenticates, validates, records, and enqueues. The Eventbrite fetch, donor
// matching and the Monday write all live in the queue consumer, where failures get retries and
// a dead-letter queue instead of dying inside a webhook request.
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  // One path for every route: authenticate, validate, record the ledger row, enqueue, mark queued.
  // A route supplies only its validator and how to record / mark a verdict's delivery.
  function route<D>(
    path: string,
    validate: (body: unknown) => { kind: 'process'; delivery: D } | { kind: 'ignore'; reason: string },
    ledger: {
      noun: string;
      id: (d: D) => string;
      message: (d: D) => WriteQueueMessage;
      record: (d: D, receivedAt: string) => Promise<unknown>;
      markQueued: (d: D) => Promise<void>;
      markFailed: (d: D, error: string) => Promise<void>;
    }
  ) {
    app.post(path, async (c) => {
      const presented = c.req.header(SECRET_HEADER) ?? c.req.query('secret');
      if (!(await secretsMatch(presented, deps.webhookSecret))) {
        return c.json({ ok: false }, 401);
      }

      let verdict;
      try {
        verdict = validate(await c.req.json());
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

      const delivery = verdict.delivery;
      await ledger.record(delivery, new Date().toISOString());

      // Every delivery is enqueued, redeliveries included: the consumer re-fetches the resource
      // and writes idempotently, so a duplicate costs one fetch and never a second item.
      try {
        const mode = await deps.writeMode();
        await deps.queue.send({ ...ledger.message(delivery), ...stampFor(mode) });
        await ledger.markQueued(delivery);
      } catch (err) {
        const errMsg = errorMessage(err);
        console.error(`eventbrite-sync webhook: enqueue failed for ${ledger.noun} "${ledger.id(delivery)}": ${errMsg}`);
        await ledger.markFailed(delivery, errMsg);
        // A 5xx gives Eventbrite the chance to redeliver; the keyed upsert makes that safe.
        return c.json({ ok: false }, 500);
      }

      return c.json({ ok: true }, 200);
    });
  }

  // The registered URL. One organization-wide webhook with the three order actions.
  route('/webhooks/eventbrite/order', (body) => validateDelivery(body, deps.config), {
    noun: 'order',
    id: (d) => d.orderId,
    message: (d) => ({ orderId: d.orderId, action: d.action }),
    record: (d, receivedAt) => deps.orderStore.recordDelivery({ orderId: d.orderId, action: d.action, receivedAt }),
    markQueued: (d) => deps.orderStore.updateStatus(d.orderId, 'queued'),
    markFailed: (d, error) => deps.orderStore.updateStatus(d.orderId, 'failed', { error }),
  });

  // Events and attendees: a second organization-wide webhook, same secret, same pointer-only rules.
  route('/webhooks/eventbrite/attendee', (body) => validateAttendeeDelivery(body, deps.config), {
    noun: 'event/attendee',
    id: (d) => (d.kind === 'event' ? d.eventId : d.attendeeId),
    message: (d) => d,
    record: (d, receivedAt) =>
      d.kind === 'event'
        ? deps.eventStore.recordDelivery({ eventId: d.eventId, action: d.action, receivedAt })
        : deps.attendeeStore.recordDelivery({ attendeeId: d.attendeeId, eventId: d.eventId, action: d.action, receivedAt }),
    markQueued: (d) => (d.kind === 'event' ? deps.eventStore.updateStatus(d.eventId, 'queued') : deps.attendeeStore.updateStatus(d.attendeeId, 'queued')),
    markFailed: (d, error) =>
      d.kind === 'event' ? deps.eventStore.updateStatus(d.eventId, 'failed', { error }) : deps.attendeeStore.updateStatus(d.attendeeId, 'failed', { error }),
  });

  if (deps.classEmails) {
    registerClassEmailRoutes(app, {
      ...deps.classEmails,
      eventStore: deps.eventStore,
      attendeeStore: deps.attendeeStore,
      config: deps.config,
      writeMode: deps.writeMode,
    });
  }

  return app;
}
