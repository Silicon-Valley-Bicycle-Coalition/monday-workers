import type { MondayTokenSource } from './monday/graphql';
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
  // Active recurring giver: renewal Journeys skip anyone carrying this tag.
  recurringDonor: string;
}

export interface MondayColumnsConfig {
  membershipStatus: string;
  membershipTier: string;
  memberSince: string;
  memberUntil: string;
  addr1: string;
  city: string;
  // null: no State column on the board; the ADDRESS merge field takes the state from the ZIP.
  state: string | null;
  zip: string;
  email: string;
  totalGiven: string;
  mailchimpCampaigns: string;
  doNotSolicit: string; // checkbox
  dnsReasonStatus: string; // status: OK / Missing / Confirmed
  // The People "Nearby" dropdown (written by nearby-search): each label becomes a Mailchimp tag.
  // null = not synced (the column doesn't exist on this board yet).
  nearby: string | null;
  // The People "Has Active Recurring Gift" checkbox (kept nightly by donation-rollups) -> the
  // recurring-donor tag. null or absent = not synced (the column isn't configured on this board).
  hasActiveRecurringGift?: string | null;
}

// The columns the outbound sync reads. Everything but the Campaigns connect column, which only the
// inbound side writes, and only on People.
export type DonorColumnsConfig = Omit<MondayColumnsConfig, 'mailchimpCampaigns'>;

// People (Historical): the same columns as People under their own ids. Outbound only.
export interface HistoricalBoardConfig {
  boardId: number;
  columns: DonorColumnsConfig;
}

// The Email Consent columns the hourly consent sync keeps current (docs/superpowers/specs/
// 2026-11-16-mailchimp-consent-columns-design.md): each address column and the status column that
// holds its Mailchimp consent, per board.
export interface ConsentPair { emailColumn: string; consentColumn: string }
export interface ConsentBoard { name: string; boardId: number; pairs: ConsentPair[] }
export interface ConsentConfig {
  // false: the hourly run logs one line and does nothing (production until David's go-ahead).
  enabled: boolean;
  // Cap on changes toward a sendable value per run; changes to Unsubscribed/Cleaned are uncapped.
  maxChangesPerRun: number;
  boards: ConsentBoard[];
}

export interface JourneyInterestsConfig {
  // Turned on once, when a contact first becomes a member (active or lifetime) — new members only.
  welcomeDrip: string | null;
  // Turned on each time a contact gains the active-member tag, unless it carries renewalOptOutTag.
  renewalReminders: string | null;
  // The tag scripts/renewal-opt-out.mjs gave Salesforce's Renewal Opt Out contacts.
  renewalOptOutTag: string;
}

export interface Config {
  monday: {
    apiUrl: string;
    donorsBoardId: number | null;
    campaignsBoardId: number | null;
    columns: MondayColumnsConfig;
    // null = this deployment watches People only.
    historical: HistoricalBoardConfig | null;
  };
  mailchimp: {
    apiBaseUrl: string;
    audienceId: string;
    mergeFields: MailchimpMergeFieldsConfig;
    tags: MailchimpTagsConfig;
    // Prepended to each Nearby label to make its Mailchimp tag ("Near: " + "Stevens Creek bikeway").
    // Also how a removed label is recognized as ours to deactivate: managedTags() adds every
    // tag the member holds that starts with it.
    nearbyTagPrefix: string;
    // The Interest Categories this Worker syncs to the Campaigns board. Every other category in
    // the audience is ignored: production's holds decades of old lists (docs/39 §3).
    interestCategoryIds: string[];
    // The Customer Journey interests the outbound sync turns on as people become members (null:
    // it manages none, as in the sandbox). See journeyInterests() in consumer/mapDonor.ts.
    journeyInterests: JourneyInterestsConfig | null;
  };
  lifetimeTierValue: string;
  activeStatusValue: string;
  // The DNS Reason Status label a reviewer sets once a Do Not Solicit reason has been checked.
  // Only then does the Worker unsubscribe the contact in Mailchimp — see consumer/outbound.ts.
  dnsConfirmedValue: string;
  consent: ConsentConfig;
}

export interface Env {
  DB: D1Database;
  OUTBOUND_QUEUE: Queue<OutboundSyncMessage>;
  INBOUND_QUEUE: Queue<InboundSyncMessage>;
  // Monday access: the monday-auth broker's SyncToken entrypoint (wrangler.jsonc services). The
  // fixed MONDAY_API_TOKEN secret is only the fallback while the OAuth cutover is under way;
  // tokenProviderFor (src/monday/graphql.ts) prefers the binding and throws if neither is set.
  MONDAY_AUTH?: MondayTokenSource;
  MONDAY_API_TOKEN?: string;
  MONDAY_WEBHOOK_SECRET: string;
  MAILCHIMP_API_KEY: string;
  MAILCHIMP_WEBHOOK_SECRET: string;
  // Optional Slack incoming-webhook URL for dead-letter alerts (GL#37, src/alert.ts). Unset = the
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
  // Set only for a change to the Donor's Email column: the address it held before, so the
  // consumer can move that Mailchimp member to the new one. Absent on messages queued before it
  // existed and on redrives, which then update by the current address as before.
  previousEmail?: string;
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
  // Labels from the Nearby dropdown; [] when unset or the column isn't configured.
  nearby: string[];
  // The Has Active Recurring Gift checkbox; false when unchecked or the column isn't configured.
  hasActiveRecurringGift: boolean;
  // Which board the item is on now, read with its columns. A move between the People boards keeps
  // the item id, so this can differ from the board its webhook named.
  onHistorical: boolean;
}

export interface MailchimpInterest {
  categoryId: string;
  interestId: string;
  name: string;
}
