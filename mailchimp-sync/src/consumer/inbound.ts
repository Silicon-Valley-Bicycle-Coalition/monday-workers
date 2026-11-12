import type { PendingInboundStore } from '../db/pendingInbound';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import type { CampaignItemRow, CampaignItemsStore } from '../db/campaignItems';
import type { Config, InboundSyncMessage } from '../types';
import { reconcileCampaigns } from '../campaigns/reconcile';
import type { QueueMessageLike } from './outbound';
import { credentialsRejectedLog, retryDelaySeconds } from './backoff';
import { OutageBreaker } from '../monday/outage';
import { MailchimpAuthError, MailchimpPermanentError } from '../mailchimp/client';
import { errorText, memberId, redactEmails } from '../logSafe';
import { messageDisposition, retryDelaySeconds as baseRetryDelaySeconds } from '../flags';
import { dryRunInboundDeps, type BatchSkipContext } from '../writeSwitch';

export interface InboundConsumerDeps {
  pendingStore: PendingInboundStore;
  mondayClient: MondayClient;
  mailchimpClient: MailchimpClient;
  campaignItemsStore: CampaignItemsStore;
  config: Config;
}

// The batch runs in three phases so its catalog work is done once, not per message (#97):
//  1. per message: read the member from Mailchimp, then find its Donor item — a member with no
//     item (or none in Mailchimp) is closed out here, before any catalog work;
//  2. once: resolve every remaining interest with one D1 query and, if any is unknown, refresh the
//     catalog with one reconcile. That reconcile runs after every member in the batch was read, so
//     it lists every interest they hold, as the per-message reconcile it replaces did;
//  3. per message: write the connect column.
// A failure in phase 1 or 3 retries (or acks) that message alone; a failed reconcile retries only
// the messages that were waiting on it. Once any failure is a Monday outage (#101), every message
// not yet finished is retried with backoff without calling Monday or Mailchimp again.
export async function processInboundBatch(
  messages: readonly QueueMessageLike<InboundSyncMessage>[],
  deps: InboundConsumerDeps,
  breaker: OutageBreaker = new OutageBreaker(),
): Promise<void> {
  let pending: Prepared[] = [];
  for (const message of messages) {
    if (breaker.open) {
      breaker.defer(message);
      continue;
    }
    try {
      const prepared = await prepare(message, deps);
      if (prepared === null) message.ack();
      else pending.push(prepared);
    } catch (err) {
      await fail(message, err, deps, breaker);
    }
  }
  if (breaker.open) {
    for (const p of pending) breaker.defer(p.message);
    return;
  }
  if (pending.length === 0) return;

  let catalog: Map<string, CampaignItemRow>;
  try {
    catalog = await deps.campaignItemsStore.getByInterestIds(pending.flatMap((p) => p.interestIds));
  } catch (err) {
    for (const p of pending) await fail(p.message, err, deps, breaker);
    return;
  }

  // Set by the reconcile: the interests in the configured categories.
  let synced: Set<string> | null = null;
  const waiting = pending.filter((p) => p.interestIds.some((id) => !catalog.has(id)));
  if (waiting.length > 0) {
    try {
      // Genuinely new interests the daily reconciliation cron hasn't picked up yet, or ones in a
      // category this Worker doesn't sync — refresh the catalog once for the batch to tell.
      const { mailchimpClient, mondayClient, campaignItemsStore, config } = deps;
      synced = new Set((await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config })).interestIds);
      const unknown = waiting.flatMap((p) => p.interestIds.filter((id) => !catalog.has(id)));
      for (const [id, row] of await campaignItemsStore.getByInterestIds(unknown)) catalog.set(id, row);
    } catch (err) {
      for (const p of waiting) await fail(p.message, err, deps, breaker);
      pending = pending.filter((p) => !waiting.includes(p));
    }
  }

  for (const p of pending) {
    if (breaker.open) {
      breaker.defer(p.message);
      continue;
    }
    try {
      await write(p, catalog, synced, deps);
      p.message.ack();
    } catch (err) {
      await fail(p.message, err, deps, breaker);
    }
  }
}

// The queue entry point (index.ts); same dispositions as consumeOutboundBatch. Live messages run
// together as one batch; each dry-run message runs alone against its own proxied deps, so its
// reconcile and catalog overlay stay its own.
export async function consumeInboundBatch(
  messages: readonly QueueMessageLike<InboundSyncMessage>[],
  deps: InboundConsumerDeps,
  gate: BatchSkipContext,
): Promise<void> {
  const live: QueueMessageLike<InboundSyncMessage>[] = [];
  // One breaker for the whole batch, dry runs included (#101).
  const breaker = new OutageBreaker();
  for (const message of messages) {
    const disposition = messageDisposition(gate.mode, message.body);
    if (disposition === 'retry') {
      message.retry({ delaySeconds: baseRetryDelaySeconds(message.attempts) });
    } else if (disposition === 'write') {
      live.push(message);
    } else if (breaker.open) {
      // Monday is down or rate-limiting (#101): rehearse this dry run on a later delivery.
      breaker.defer(message);
    } else {
      // The message body carries an address; the skip lines name the member by hash instead.
      const dry = dryRunInboundDeps(deps, { ...gate, deliveryId: redactEmails(message.body.email) });
      try {
        await dry.pendingStore.updateStatus(message.body.email, 'dropped');
      } catch (err) {
        // A D1 failure must not escape the batch (every unacked message would redeliver at once):
        // back this one off like any other failure and rehearse it next time.
        console.error(`mailchimp-sync inbound consumer: could not record dropped status for member ${memberId(message.body.email)}: ${errorText(err)}`);
        message.retry({ delaySeconds: baseRetryDelaySeconds(message.attempts) });
        continue;
      }
      await processInboundBatch([message], dry, breaker);
    }
  }
  if (live.length > 0) await processInboundBatch(live, deps, breaker);
}

interface Prepared {
  message: QueueMessageLike<InboundSyncMessage>;
  donorItemId: string;
  // The member's subscribed interests, in Mailchimp's order.
  interestIds: string[];
}

async function fail(message: QueueMessageLike<InboundSyncMessage>, err: unknown, deps: InboundConsumerDeps, breaker: OutageBreaker): Promise<void> {
  const { email } = message.body;
  const errMsg = err instanceof Error ? err.message : String(err);
  console.error(`mailchimp-sync inbound consumer: failed to process member ${memberId(email)}: ${redactEmails(errMsg)}`);
  if (err instanceof MailchimpAuthError) console.error(credentialsRejectedLog('inbound'));
  // Recording the failure is bookkeeping; a D1 error here must not skip the delayed retry.
  try {
    await deps.pendingStore.updateStatus(email, 'failed', errMsg);
  } catch (recordErr) {
    console.error(`mailchimp-sync inbound consumer: could not record failure for member ${memberId(email)}: ${errorText(recordErr)}`);
  }
  // Same rule as the outbound consumer: a permanent (non-auth 4xx) Mailchimp error fails
  // identically on every retry, so ack it — the row keeps the error. MailchimpAuthError is a
  // MailchimpTransientError, never permanent, so a rejected key still retries and dead-letters.
  if (err instanceof MailchimpPermanentError) {
    message.ack();
  } else {
    // A Monday outage also defers the rest of the batch (#101); this message's delay is the same.
    if (breaker.trip(err)) console.error('mailchimp-sync inbound consumer: Monday unavailable, deferring the rest of the batch');
    message.retry({ delaySeconds: retryDelaySeconds(message.attempts, err) });
  }
}

// Phase 1. Null when the message is finished (recorded written or skipped) and only needs its ack.
async function prepare(message: QueueMessageLike<InboundSyncMessage>, deps: InboundConsumerDeps): Promise<Prepared | null> {
  const { mondayClient, mailchimpClient, config, pendingStore } = deps;
  const { email } = message.body;

  const member = await mailchimpClient.getMemberInterests(email);
  if (member === null) {
    await pendingStore.updateStatus(email, 'written', undefined, new Date().toISOString());
    return null;
  }

  const donorsBoardId = config.monday.donorsBoardId;
  if (donorsBoardId === null) {
    throw new Error('config: monday.donorsBoardId must be set before inbound sync can run');
  }

  // Before any catalog work: a member with no Donor item has nothing to write, so it must not
  // cost a reconcile (#97).
  const donorItemId = await mondayClient.findItemIdByEmail(donorsBoardId, config.monday.columns.email, email);
  if (donorItemId === null) {
    // A genuine miss (even after the client's case-insensitive fallback) must stay
    // distinguishable from a successful write — 'skipped', never 'written', so misses
    // are visible and countable in the pending table.
    console.warn(`mailchimp-sync inbound consumer: no Donor item matches member ${memberId(email)} — recording as skipped`);
    await pendingStore.updateStatus(email, 'skipped', `no Donor item matches email "${email}"`);
    return null;
  }

  // Mailchimp preserves `interests` unchanged after a contact unsubscribes/is cleaned/
  // archived, so a status other than actively-subscribed means no active connections at
  // all — skip resolving interests entirely and clear the connect column.
  const isActivelySubscribed = member.status === 'subscribed' || member.status === 'pending';
  const interestIds = isActivelySubscribed
    ? Object.entries(member.interests)
        .filter(([, subscribed]) => subscribed)
        .map(([interestId]) => interestId)
    : [];
  return { message, donorItemId, interestIds };
}

// Phase 3.
async function write(p: Prepared, catalog: ReadonlyMap<string, CampaignItemRow>, synced: ReadonlySet<string> | null, deps: InboundConsumerDeps): Promise<void> {
  const { mondayClient, config, pendingStore } = deps;
  const campaignItemIds: string[] = [];
  for (const interestId of p.interestIds) {
    const row = catalog.get(interestId);
    if (row !== undefined) {
      campaignItemIds.push(row.mondayItemId);
    } else if (synced !== null && !synced.has(interestId)) {
      // Outside mailchimp.interestCategoryIds (an old list, say): not a campaign, left off.
      continue;
    } else {
      // Still unresolvable even after a fresh reconcile — surface this loudly instead of
      // silently under-populating the connect column. Retries via the Queue and eventually
      // DLQs like any genuine failure.
      throw new Error(`interest "${interestId}" could not be resolved to a Campaigns-board item even after reconciliation`);
    }
  }

  // donorsBoardId was checked in prepare().
  await mondayClient.setConnectColumn(config.monday.donorsBoardId!, p.donorItemId, config.monday.columns.mailchimpCampaigns, campaignItemIds);
  await pendingStore.updateStatus(p.message.body.email, 'written', undefined, new Date().toISOString());
}
