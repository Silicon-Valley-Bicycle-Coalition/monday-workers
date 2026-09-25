import type { PendingOutboundStore } from '../db/pendingOutbound';
import type { DnsUnsubscribeLog } from '../db/dnsUnsubscribes';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import { MailchimpPermanentError } from '../mailchimp/client';
import type { Config, OutboundSyncMessage } from '../types';
import { buildMergeFields, buildTags, managedTags } from './mapDonor';
import { retryDelaySeconds } from './backoff';

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
  for (const message of messages) {
    const { donorItemId } = message.body;
    try {
      await processOne(donorItemId, deps);
      message.ack();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`mailchimp-sync outbound consumer: failed to process donor "${donorItemId}": ${errMsg}`);
      // Recording the failure is bookkeeping; a D1 error here must not take the ack/retry
      // decision down with it (the throw would fail the whole batch and retry every message
      // immediately, with no backoff).
      try {
        await deps.pendingStore.updateStatus(donorItemId, 'failed', errMsg);
      } catch (recordErr) {
        console.error(`mailchimp-sync outbound consumer: could not record failure for donor "${donorItemId}": ${recordErr instanceof Error ? recordErr.message : String(recordErr)}`);
      }
      if (err instanceof MailchimpPermanentError) {
        message.ack(); // retrying a malformed address fails identically every time
      } else {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts, err) });
      }
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
