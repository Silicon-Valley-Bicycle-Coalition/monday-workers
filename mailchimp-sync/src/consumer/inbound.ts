import type { PendingInboundStore } from '../db/pendingInbound';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import type { CampaignItemsStore } from '../db/campaignItems';
import type { Config, InboundSyncMessage } from '../types';
import { reconcileCampaigns } from '../campaigns/reconcile';
import type { QueueMessageLike } from './outbound';
import { credentialsRejectedLog, retryDelaySeconds } from './backoff';
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

export async function processInboundBatch(
  messages: readonly QueueMessageLike<InboundSyncMessage>[],
  deps: InboundConsumerDeps,
): Promise<void> {
  for (const message of messages) await handleMessage(message, deps);
}

// The queue entry point (index.ts); same dispositions as consumeOutboundBatch. A dry run's inline
// reconcile (below) uses the proxied deps, so it takes its message's disposition.
export async function consumeInboundBatch(
  messages: readonly QueueMessageLike<InboundSyncMessage>[],
  deps: InboundConsumerDeps,
  gate: BatchSkipContext,
): Promise<void> {
  for (const message of messages) {
    const disposition = messageDisposition(gate.mode, message.body);
    if (disposition === 'retry') {
      message.retry({ delaySeconds: baseRetryDelaySeconds(message.attempts) });
    } else if (disposition === 'write') {
      await handleMessage(message, deps);
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
      await handleMessage(message, dry);
    }
  }
}

async function handleMessage(message: QueueMessageLike<InboundSyncMessage>, deps: InboundConsumerDeps): Promise<void> {
  const { email } = message.body;
  try {
    await processOne(email, deps);
    message.ack();
  } catch (err) {
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
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts, err) });
    }
  }
}

async function processOne(email: string, deps: InboundConsumerDeps): Promise<void> {
  const { mondayClient, mailchimpClient, campaignItemsStore, config, pendingStore } = deps;

  const member = await mailchimpClient.getMemberInterests(email);
  if (member === null) {
    await pendingStore.updateStatus(email, 'written', undefined, new Date().toISOString());
    return;
  }

  // Mailchimp preserves `interests` unchanged after a contact unsubscribes/is cleaned/
  // archived, so a status other than actively-subscribed means no active connections at
  // all — skip resolving interests entirely and clear the connect column below.
  const isActivelySubscribed = member.status === 'subscribed' || member.status === 'pending';

  const subscribedInterestIds = isActivelySubscribed
    ? Object.entries(member.interests)
        .filter(([, subscribed]) => subscribed)
        .map(([interestId]) => interestId)
    : [];

  const campaignItemIds: string[] = [];
  // Set by the first reconcile: the interests in the configured categories.
  let synced: Set<string> | null = null;
  for (const interestId of subscribedInterestIds) {
    let row = await campaignItemsStore.getByInterestId(interestId);
    if (row === null && synced === null) {
      // Genuinely new interest the daily reconciliation cron hasn't picked up yet, or one in a
      // category this Worker doesn't sync — refresh the catalog once within this run to tell.
      const result = await reconcileCampaigns({ mailchimpClient, mondayClient, campaignItemsStore, config });
      synced = new Set(result.interestIds);
      row = await campaignItemsStore.getByInterestId(interestId);
    }
    if (row !== null) {
      campaignItemIds.push(row.mondayItemId);
    } else if (synced !== null && !synced.has(interestId)) {
      // Outside mailchimp.interestCategoryIds (an old list, say): not a campaign, left off.
      continue;
    } else if (synced !== null) {
      // Still unresolvable even after a fresh reconcile — surface this loudly instead of
      // silently under-populating the connect column. Propagates to processInboundBatch's
      // catch, which retries via the Queue and eventually DLQs like any genuine failure.
      throw new Error(`interest "${interestId}" could not be resolved to a Campaigns-board item even after reconciliation`);
    }
  }

  const donorsBoardId = config.monday.donorsBoardId;
  if (donorsBoardId === null) {
    throw new Error('config: monday.donorsBoardId must be set before inbound sync can run');
  }

  const donorItemId = await mondayClient.findItemIdByEmail(donorsBoardId, config.monday.columns.email, email);
  if (donorItemId === null) {
    // A genuine miss (even after the client's case-insensitive fallback) must stay
    // distinguishable from a successful write — 'skipped', never 'written', so misses
    // are visible and countable in the pending table.
    console.warn(`mailchimp-sync inbound consumer: no Donor item matches member ${memberId(email)} — recording as skipped`);
    await pendingStore.updateStatus(email, 'skipped', `no Donor item matches email "${email}"`);
    return;
  }

  await mondayClient.setConnectColumn(donorsBoardId, donorItemId, config.monday.columns.mailchimpCampaigns, campaignItemIds);
  await pendingStore.updateStatus(email, 'written', undefined, new Date().toISOString());
}
