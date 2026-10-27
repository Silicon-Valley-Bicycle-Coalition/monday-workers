import type { WriteStamp } from './flags';

export interface MailchimpMergeFieldsConfig {
  memberSince: string;
  memberUntil: string;
  membershipTier: string;
  membershipStatus: string;
  address: string;
  totalGiven: string;
}

export interface MailchimpTagsConfig {
  activeMember: string;
  lapsedMember: string;
  lifetimeMember: string;
  hasDonated: string;
  doNotSolicit: string;
}

export interface MondayColumnsConfig {
  membershipStatus: string;
  membershipTier: string;
  memberSince: string;
  memberUntil: string;
  addr1: string;
  city: string;
  state: string;
  zip: string;
  email: string;
  totalGiven: string;
  mailchimpCampaigns: string;
  doNotSolicit: string; // checkbox
  dnsReasonStatus: string; // status: OK / Missing / Confirmed
}

export interface Config {
  monday: {
    apiUrl: string;
    donorsBoardId: number | null;
    campaignsBoardId: number | null;
    columns: MondayColumnsConfig;
  };
  mailchimp: {
    apiBaseUrl: string;
    audienceId: string;
    mergeFields: MailchimpMergeFieldsConfig;
    tags: MailchimpTagsConfig;
  };
  lifetimeTierValue: string;
  activeStatusValue: string;
  // The DNS Reason Status label a reviewer sets once a Do Not Solicit reason has been checked.
  // Only then does the Worker unsubscribe the contact in Mailchimp — see consumer/outbound.ts.
  dnsConfirmedValue: string;
}

export interface Env {
  DB: D1Database;
  OUTBOUND_QUEUE: Queue<OutboundSyncMessage>;
  INBOUND_QUEUE: Queue<InboundSyncMessage>;
  MONDAY_API_TOKEN: string;
  MONDAY_WEBHOOK_SECRET: string;
  MAILCHIMP_API_KEY: string;
  MAILCHIMP_WEBHOOK_SECRET: string;
  // Optional Slack incoming-webhook URL for dead-letter alerts (#37, src/alert.ts). Unset = the
  // DLQ consumer's console.error is the only signal.
  SLACK_WEBHOOK_URL?: string;
  // Provisioned in wrangler.jsonc — see README "Reliability: traffic and cost limits".
  REQUEST_RATE_LIMITER: RateLimit;
  // The write switch (src/flags.ts): holds `mailchimp-sync:writes` and `mailchimp-sync:log`.
  FLAGS?: KVNamespace;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
}

export interface OutboundSyncMessage extends WriteStamp {
  donorItemId: string;
}

export interface InboundSyncMessage extends WriteStamp {
  email: string;
}

// 'skipped' = processed to completion but no Monday write happened (e.g. no Donor
// item matches the email) — distinct from 'written' so misses stay countable.
// 'dropped' = ingested while writes were `off`: closed out so nothing can revive it as live work.
export type PendingStatus = 'received' | 'queued' | 'written' | 'skipped' | 'failed' | 'dropped';

// One pending_outbound_syncs / pending_inbound_syncs row as the dead-letter consumer reads it
// (src/consumer/deadLetters.ts) — the key column is left out because the caller already has it.
export interface PendingRow {
  status: PendingStatus;
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}

// A Donor item's column values, already resolved to plain strings — '' means the
// column was blank, never undefined/missing (see monday/client.ts's getDonorById).
export interface DonorRecord {
  id: string;
  email: string;
  membershipStatus: string;
  membershipTier: string;
  memberSince: string; // YYYY-MM-DD or ''
  memberUntil: string; // YYYY-MM-DD or ''
  addr1: string;
  city: string;
  state: string;
  zip: string;
  totalGiven: string;
  doNotSolicit: boolean;
  dnsReasonStatus: string;
}

export interface MailchimpInterest {
  categoryId: string;
  interestId: string;
  name: string;
}
