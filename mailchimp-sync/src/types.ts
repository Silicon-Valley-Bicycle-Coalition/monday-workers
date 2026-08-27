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
}

export interface Env {
  DB: D1Database;
  OUTBOUND_QUEUE: Queue<OutboundSyncMessage>;
  INBOUND_QUEUE: Queue<InboundSyncMessage>;
  MONDAY_API_TOKEN: string;
  MONDAY_WEBHOOK_SECRET?: string;
  MAILCHIMP_API_KEY: string;
  MAILCHIMP_WEBHOOK_SECRET?: string;
}

export interface OutboundSyncMessage {
  donorItemId: string;
}

export interface InboundSyncMessage {
  email: string;
}

export type PendingStatus = 'received' | 'queued' | 'written' | 'failed';

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
}

export interface MailchimpInterest {
  categoryId: string;
  interestId: string;
  name: string;
}
