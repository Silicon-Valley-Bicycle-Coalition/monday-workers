import type { PendingOutboundStore } from '../db/pendingOutbound';
import type { MondayClient } from '../monday/client';
import type { MailchimpClient } from '../mailchimp/client';
import { MailchimpPermanentError } from '../mailchimp/client';
import type { Config, OutboundSyncMessage } from '../types';
import { buildMergeFields, buildTags } from './mapDonor';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface OutboundConsumerDeps {
  pendingStore: PendingOutboundStore;
  mondayClient: MondayClient;
  mailchimpClient: MailchimpClient;
  config: Config;
}

export async function processOutboundBatch(
  messages: QueueMessageLike<OutboundSyncMessage>[],
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
      await deps.pendingStore.updateStatus(donorItemId, 'failed', errMsg);
      if (err instanceof MailchimpPermanentError) {
        message.ack(); // retrying a malformed address fails identically every time
      } else {
        message.retry();
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

  await mailchimpClient.upsertMember(donor.email, buildMergeFields(donor, config), buildTags(donor, config));
  await pendingStore.updateStatus(donorItemId, 'written', undefined, new Date().toISOString());
}
