import { Hono } from 'hono';
import type { PendingOutboundStore } from '../db/pendingOutbound';
import { validateMondayWebhookBody } from './validateMonday';
import type { Config, OutboundSyncMessage } from '../types';
import { stampFor, type WriteMode } from '../flags';
import { MONDAY_WEBHOOK_PATH } from '../rateLimit';
import { secretsMatch } from '../secret';
import { checkMondayWebhookJwt, type MondayJwtPolicy } from '../mondayJwt';
import { columnsForBoard, donorColumnIds } from '../monday/client';

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
  // Second factor: a webhook created by an app (through monday-auth's Staff sync app) carries
  // `Authorization: <JWT>` signed with the app's Signing Secret; one created with a personal token
  // carries none. See src/mondayJwt.ts for the rollout policy. Absent = the URL secret alone
  // decides, as before.
  jwtPolicy?: MondayJwtPolicy;
  // Needed to recognize and skip this Worker's own self-inflicted events: the inbound
  // consumer writes to config.monday.columns.mailchimpCampaigns on this same Donors board,
  // which would otherwise re-trigger this webhook and risk a feedback loop with Mailchimp.
  config: Config;
  // The write switch (flags.ts readWriteMode), read once per delivery that gets enqueued. Ingest
  // is never gated: under `off` the message is stamped dropped, so the consumer dry-runs it even if
  // writes are back `on` by the time it is consumed.
  writeMode: () => Promise<WriteMode>;
}

// Ingest-and-enqueue only — resolving the Donor's current columns and writing to
// Mailchimp both happen in the queue consumer (src/consumer/outbound.ts), where a
// transient failure gets retries and a dead-letter queue.
export function createOutboundApp(deps: OutboundAppDeps) {
  const app = new Hono();

  app.post(MONDAY_WEBHOOK_PATH, async (c) => {
    // Auth first — even the one-time challenge handshake stays behind the secret, since the
    // secret is part of the URL Monday registers and so arrives with the challenge too. An
    // unauthenticated caller learns nothing and enqueues nothing.
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
    // verbatim, sent once at subscription-creation time.
    if (typeof body === 'object' && body !== null && 'challenge' in body) {
      return c.json({ challenge: (body as { challenge: unknown }).challenge }, 200);
    }

    // After the handshake: the echo has no side effect and the URL secret already gated it.
    const jwt = await checkMondayWebhookJwt(c.req.header('Authorization'), c.req.url, deps.jwtPolicy ?? {});
    if (!jwt.accept) {
      console.error(`mailchimp-sync outbound webhook: rejected delivery: JWT ${jwt.reason}`);
      return c.json({ ok: false }, 401);
    }
    if (!jwt.verified && jwt.note === 'missing') {
      console.warn('mailchimp-sync outbound webhook: delivery carried no Authorization JWT; accepted on the URL secret alone (MONDAY_WEBHOOK_JWT_REQUIRED is not true). Re-register the subscription with the Staff sync app token.');
    }

    let donorEvent;
    try {
      donorEvent = validateMondayWebhookBody(body);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync outbound webhook: rejected delivery: ${errMsg}`);
      return c.json({ ok: false, error: errMsg }, 200);
    }

    // A change to a column the sync doesn't read can't change what it would send: skip without
    // enqueueing. That covers the inbound consumer's own write to the mailchimpCampaigns
    // connect-column (an outbound→Mailchimp→inbound feedback loop otherwise), and bulk writes to
    // unrelated columns, such as a Location backfill. Item creation carries no columnId and
    // always enqueues.
    // Column ids differ between People and People (Historical), so read against the event's board.
    const columns = columnsForBoard(deps.config.monday, donorEvent.boardId);
    if (donorEvent.columnId !== undefined && !donorColumnIds(columns).includes(donorEvent.columnId)) {
      return c.json({ ok: true, skipped: true }, 200);
    }

    await deps.pendingStore.upsertPending(donorEvent.donorItemId, new Date().toISOString());

    // Only the configured Email column's old address: an email-shaped value from any other
    // column (Household Email) must not move this Donor's Mailchimp member.
    const previousEmail = donorEvent.columnId === columns.email ? donorEvent.previousEmail : undefined;
    const stamp = stampFor(await deps.writeMode());
    try {
      await deps.queue.send({ donorItemId: donorEvent.donorItemId, ...(previousEmail === undefined ? {} : { previousEmail }), ...stamp });
      await deps.pendingStore.updateStatus(donorEvent.donorItemId, stamp.writeStamp === 'dropped' ? 'dropped' : 'queued');
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
