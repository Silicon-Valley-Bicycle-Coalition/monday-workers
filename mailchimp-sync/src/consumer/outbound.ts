import type { PendingOutboundStore } from '../db/pendingOutbound';
import type { DnsUnsubscribeLog } from '../db/dnsUnsubscribes';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import { MailchimpAuthError, MailchimpPermanentError } from '../mailchimp/client';
import type { Config, OutboundSyncMessage } from '../types';
import { buildMergeFields, buildTags, managedTags } from './mapDonor';
import { credentialsRejectedLog, retryDelaySeconds } from './backoff';
import { errorText, redactEmails } from '../logSafe';
import { messageDisposition, retryDelaySeconds as baseRetryDelaySeconds } from '../flags';
import { dryRunOutboundDeps, type BatchSkipContext } from '../writeSwitch';

export interface QueueMessageLike<T> {
  body: T;
  // Cloudflare's Message.attempts (1 on first delivery). Optional so tests can omit it.
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface OutboundConsumerDeps {
  pendingStore: PendingOutboundStore;
  mondayClient: MondayClient;
  mailchimpClient: MailchimpClient;
  config: Config;
  dnsLog: DnsUnsubscribeLog;
}

export async function processOutboundBatch(
  messages: readonly QueueMessageLike<OutboundSyncMessage>[],
  deps: OutboundConsumerDeps,
): Promise<void> {
  for (const message of messages) await handleMessage(message, deps);
}

// The queue entry point (index.ts): the write switch's mode, read once for the batch, decides per
// message whether it writes (`on`, unstamped), dry-runs against recording proxies (`off`, or
// stamped dropped by the webhook), or waits on the queue (`hold`, `unknown`).
export async function consumeOutboundBatch(
  messages: readonly QueueMessageLike<OutboundSyncMessage>[],
  deps: OutboundConsumerDeps,
  gate: BatchSkipContext,
): Promise<void> {
  for (const message of messages) {
    const disposition = messageDisposition(gate.mode, message.body);
    if (disposition === 'retry') {
      message.retry({ delaySeconds: baseRetryDelaySeconds(message.attempts) });
    } else if (disposition === 'write') {
      await handleMessage(message, deps);
    } else {
      const dry = dryRunOutboundDeps(deps, { ...gate, deliveryId: message.body.donorItemId });
      // The one pending write a dry run makes, so a row can never look like work in flight.
      try {
        await dry.pendingStore.updateStatus(message.body.donorItemId, 'dropped');
      } catch (err) {
        // A D1 failure must not escape the batch (every unacked message would redeliver at once):
        // back this one off like any other failure and rehearse it next time.
        console.error(`mailchimp-sync outbound consumer: could not record dropped status for donor ${message.body.donorItemId}: ${errorText(err)}`);
        message.retry({ delaySeconds: baseRetryDelaySeconds(message.attempts) });
        continue;
      }
      await handleMessage(message, dry);
    }
  }
}

async function handleMessage(message: QueueMessageLike<OutboundSyncMessage>, deps: OutboundConsumerDeps): Promise<void> {
  const { donorItemId } = message.body;
  try {
    await processOne(donorItemId, deps);
    message.ack();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`mailchimp-sync outbound consumer: failed to process donor "${donorItemId}": ${redactEmails(errMsg)}`);
    if (err instanceof MailchimpAuthError) console.error(credentialsRejectedLog('outbound'));
    // Recording the failure is bookkeeping; a D1 error here must not take the ack/retry
    // decision down with it (the throw would fail the whole batch and retry every message
    // immediately, with no backoff).
    try {
      await deps.pendingStore.updateStatus(donorItemId, 'failed', errMsg);
    } catch (recordErr) {
      console.error(`mailchimp-sync outbound consumer: could not record failure for donor "${donorItemId}": ${errorText(recordErr)}`);
    }
    // A rejected API key (MailchimpAuthError) is deliberately *not* permanent: acking it would
    // drop the whole backlog behind a bad or rotated key with nothing left to replay.
    if (err instanceof MailchimpPermanentError) {
      message.ack(); // retrying a malformed address fails identically every time
    } else {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts, err) });
    }
  }
}

async function processOne(donorItemId: string, deps: OutboundConsumerDeps): Promise<void> {
  const { mondayClient, mailchimpClient, config, pendingStore } = deps;

  const donor = await mondayClient.getDonorById(donorItemId, config.monday.columns);
  if (donor === null || donor.email === '') {
    await pendingStore.updateStatus(donorItemId, 'written', undefined, new Date().toISOString());
    return;
  }

  const result = await mailchimpClient.updateMember(donor.email, buildMergeFields(donor, config), buildTags(donor, config), managedTags(config));
  if (result === 'not-in-audience') {
    // Expected for every Donor who never opted in — Mailchimp owns consent, so this
    // Worker only enriches existing members. 'skipped', not 'written', so it's countable.
    await pendingStore.updateStatus(donorItemId, 'skipped', `"${donor.email}" is not in the Mailchimp audience`);
    return;
  }

  // A reviewed Do Not Solicit unsubscribes the person's own address — never the Household
  // Email, which other people may share. The log makes this once per address: later column
  // changes on the same person don't call Mailchimp again, and unchecking the box never
  // resubscribes (only the person can, through Mailchimp).
  if (donor.doNotSolicit && donor.dnsReasonStatus === config.dnsConfirmedValue && !(await deps.dnsLog.has(donor.email))) {
    const result = await mailchimpClient.unsubscribeMember(donor.email);
    await deps.dnsLog.record(donor.email, donorItemId, result, new Date().toISOString());
  }

  await pendingStore.updateStatus(donorItemId, 'written', undefined, new Date().toISOString());
}
