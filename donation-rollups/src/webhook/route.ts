import { Hono } from 'hono';
import type { PendingStore } from '../db/pending';
import { validateWebhookBody } from './validate';
import type { RecomputeKind, RecomputeQueueMessage } from '../types';
import { secretsMatch } from '../secret';
import { MONDAY_WEBHOOK_PATH } from '../rateLimit'; // one path, so the limiter exemption can't drift from the route
import { stampFor, type WriteMode } from '../flags';

export interface QueueLike {
  send(message: RecomputeQueueMessage, opts?: { delaySeconds: number }): Promise<void>;
}

export interface AppDeps {
  pendingStore: PendingStore;
  queue: QueueLike;
  // The configured Donations boards (config.donationRollups.donationBoards, stringified).
  // Events from any other board — e.g. a stale webhook subscription on a superseded
  // sandbox board — are acknowledged and ignored at ingest, because a board outside
  // config is a permanent mismatch: enqueued it would retry three times and DLQ on
  // every delivery, and a 4xx would make Monday retry or eventually disable the
  // subscription. We want stale subscriptions visibly ignored, not churning.
  donationBoardIds: ReadonlySet<string>;
  // Event Registrations boards → the column ids whose changes matter (Attendee, Event,
  // Attendance, Role, Hours). create_pulse and item deletion always matter; any other column
  // change on these boards is acknowledged and ignored.
  registrationBoards: ReadonlyMap<string, ReadonlySet<string>>;
  // The Affiliations board → the column ids that decide a person's Employer Name (Person,
  // Organization, Status, Primary). Anything else is ignored, notably the attributed totals this
  // Worker writes to that same board. Absent while employer sync is off.
  affiliationBoards?: ReadonlyMap<string, ReadonlySet<string>>;
  // "<boardId>:<columnId>" for the classify duty's own output columns (spec 2026-09-29 §10.2):
  // writing them must not enqueue owner recomputes, or the first classify pass floods the queue.
  ignoredColumnIds: ReadonlySet<string>;
  // Monday doesn't sign webhooks created through the API's create_webhook mutation (no HMAC
  // or JWT to verify) — the standard mitigation is a shared secret embedded in the webhook URL
  // itself, set when subscribing (e.g. .../webhooks/monday/donations?secret=...) and checked
  // here in constant time. Fails closed (issue #27): undefined/empty rejects every request,
  // including the subscription handshake — set MONDAY_WEBHOOK_SECRET in .dev.vars for local dev.
  webhookSecret?: string;
  // The write switch (flags.ts readWriteMode), read once per delivery that gets enqueued. Ingest
  // runs in every mode — the pending row and the enqueue are this Worker's own bookkeeping, and
  // `hold` keeps the queue paused — but a message enqueued under `off` is stamped dropped, so the
  // consumer dry-runs it even if writes are back `on` by the time it is consumed.
  writeMode: () => Promise<WriteMode>;
}

export const WEBHOOK_DELAY_SECONDS = 20;

// Ingest-and-enqueue only, same division of labor as every other webhook-driven
// Worker in this monorepo: resolving the owner and writing to Monday both happen in
// the queue consumer, where a transient failure gets retries and a dead-letter queue
// instead of dying inside the webhook request (see root README's Reliability section).
export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post(MONDAY_WEBHOOK_PATH, async (c) => {
    if (!(await secretsMatch(c.req.query('secret'), deps.webhookSecret))) {
      return c.json({ ok: false }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'invalid JSON body' }, 200);
    }

    // Monday's webhook-subscription verification handshake: echo the challenge back
    // verbatim, no other processing. Sent once, at subscription-creation time.
    if (typeof body === 'object' && body !== null && 'challenge' in body) {
      return c.json({ challenge: (body as { challenge: unknown }).challenge }, 200);
    }

    let donationEvent;
    try {
      donationEvent = validateWebhookBody(body);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donation-rollups webhook: rejected delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    const registrationColumns = deps.registrationBoards.get(donationEvent.boardId);
    const affiliationColumns = deps.affiliationBoards?.get(donationEvent.boardId);
    const kind: RecomputeKind = registrationColumns !== undefined ? 'registration' : affiliationColumns !== undefined ? 'affiliation' : 'donation';
    if (kind === 'donation' && !deps.donationBoardIds.has(donationEvent.boardId)) {
      console.warn(`donation-rollups webhook: ignoring event for item "${donationEvent.donationItemId}" on board "${donationEvent.boardId}" — not in config.donationBoards or volunteerBoards (stale subscription?)`);
      return c.json({ ok: true, ignored: `board "${donationEvent.boardId}" not in config.donationBoards or volunteerBoards` }, 200);
    }
    if (donationEvent.columnId !== null && deps.ignoredColumnIds.has(`${donationEvent.boardId}:${donationEvent.columnId}`)) {
      return c.json({ ok: true, ignored: `classification column "${donationEvent.columnId}"` }, 200);
    }
    if (kind === 'registration' && donationEvent.columnId !== null && !registrationColumns!.has(donationEvent.columnId)) {
      return c.json({ ok: true, ignored: `registration column "${donationEvent.columnId}" does not affect membership` }, 200);
    }

    if (kind === 'affiliation' && donationEvent.columnId !== null && !affiliationColumns!.has(donationEvent.columnId)) {
      return c.json({ ok: true, ignored: `affiliation column "${donationEvent.columnId}" does not affect Employer Name` }, 200);
    }

    await deps.pendingStore.upsertPending({
      donationItemId: donationEvent.donationItemId,
      donationBoardId: donationEvent.boardId,
      eventId: donationEvent.eventId,
      receivedAt: new Date().toISOString(),
      kind,
    });

    const stamp = stampFor(await deps.writeMode());
    try {
      // The delay (issue #89) lets a burst of edits land — each one re-stamps received_at on the
      // pending row — before the first message reads Monday, so the rest coalesce on that read.
      // columnId lets the consumer coalesce a non-link edit from the D1 link, with no Monday call.
      await deps.queue.send({
        ...(kind !== 'donation' ? { kind } : {}),
        donationItemId: donationEvent.donationItemId, donationBoardId: donationEvent.boardId,
        ...(kind === 'donation' && donationEvent.columnId !== null ? { columnId: donationEvent.columnId } : {}),
        ...stamp,
      }, { delaySeconds: WEBHOOK_DELAY_SECONDS });
      // A delivery stamped dropped is a dry run from the start: recorded as 'dropped', not
      // 'queued', so the nightly requeue never re-sends it as a live recompute later.
      await deps.pendingStore.updateStatus(donationEvent.donationItemId, stamp.writeStamp === 'dropped' ? 'dropped' : 'queued');
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donation-rollups webhook: enqueue failed for donation "${donationEvent.donationItemId}": ${errMsg}`);
      await deps.pendingStore.updateStatus(donationEvent.donationItemId, 'failed', { error: errMsg });
      // A 5xx gives Monday the chance to redeliver; upserting by donation id makes a
      // redelivery safe either way.
      return c.json({ ok: false }, 500);
    }

    return c.json({ ok: true }, 200);
  });

  return app;
}
