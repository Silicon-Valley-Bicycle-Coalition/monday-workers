import type { FunraiseQueueMessage } from './consumer/processBatch';

// Funraise fires one webhook per organization and only for transactions (help.funraise.io
// "Webhooks"; decided 2026-09-18, docs/superpowers/specs/2026-09-18-funraise-subscriptions-
// poller-design.md). Subscriptions are polled, not delivered, and registrations have no source.
// Kept as a named type because the D1 `events.entity_type` column stores it.
export type EntityType = 'transaction';
export type EventStatus = 'received' | 'matched' | 'queued' | 'written' | 'failed';

export interface EventRow {
  eventId: string;
  entityType: EntityType;
  entityId: string;
  rawPayload: string;
  matchedDonorItemId: string | null;
  mondayItemId: string | null;
  status: EventStatus;
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}

export interface MondayBoards {
  'donations:live': number | null;
  'recurring-gifts': number | null;
  'people-live': number | null;
}

// The Recurring Gifts board columns the subscriptions poller writes. Each is a Monday column id
// or null to skip that column (a fork whose board lacks it).
export interface RecurringGiftColumns {
  funraiseId: string | null;
  donor: string | null;
  installmentAmount: string | null;
  annualizedValue: string | null;
  frequency: string | null;
  status: string | null;
  nextPayment: string | null;
  designation: string | null;
  companyMatch: string | null;
  matchEmployer: string | null;
}

export interface SubscriptionsPollConfig {
  enabled: boolean;
  columns: RecurringGiftColumns;
  // Annualized Value = installment × multiplier[frequency]; a frequency missing here leaves the
  // column unset (docs/03: computed, never copied).
  frequencyMultiplier: Record<string, number>;
  // Funraise subscription status → Recurring Gifts board Status label. Unmapped → column unset.
  statusLabelMap: Record<string, string>;
  // Prefix for the Funraise ID link's url; the bare id is the link text.
  funraiseLinkBase: string;
}

export interface FunraiseSyncConfig {
  monday: {
    apiUrl: string;
    boards: MondayBoards;
  };
  funraiseSync: {
    // Funraise transaction field path (relative to the delivery's `data`) → Donations column id.
    columnMap: Record<string, string>;
    // Field path for the Donations item name, and for the transaction's own id (dedup key).
    itemNameField: string;
    entityIdField: string;
    // Monday text column on the Donations board holding the Funraise transaction id; enables the
    // consumer's orphan-recovery lookup before create. null disables it.
    entityIdColumn: string | null;
    // Checkbox column on the Donations board, set true on a transaction's first write only —
    // Funraise's own transaction-time donor receipt already covers acknowledgment (migration-plan.md
    // Decisions Needed, Option 2). null disables it.
    thankYouSentColumn: string | null;
    // Text column on the Donations board stamped with giftTypeValue on a transaction's first
    // write only — donation-rollups' membership rule only counts gifts whose Gift Type is in its
    // eligible list (spec 2026-09-15), and staff may later reclassify a gift, so updates never
    // touch it. null disables the stamp. A transaction carrying `fundraisingEvent` (a paid ticket)
    // gets eventGiftTypeValue instead, so a ticket never extends a membership.
    giftTypeColumn: string | null;
    giftTypeValue: string;
    eventGiftTypeValue: string;
    // Text column on the Donations board holding the SVBC fiscal year (July–June, named for the
    // calendar year it ends in) that the gift falls in, derived from the transaction's
    // `donationDate` on first write only — it isn't a Funraise field, so columnMap can't map it.
    // salesforce-import stamps the same column on every migrated gift; donation-rollups reads it
    // and derives from Date when blank but never backfills (decision 2026-09-17). null disables it.
    fiscalYearColumn: string | null;
    // Connect column on the Donations board pointing at the Recurring Gifts board; set on every
    // write of an installment (a transaction carrying `subscription.id`). null disables it.
    recurringGiftLinkColumn: string | null;
    rawPayloadRetentionDays: number;
    unresolvedPayloadRetentionDays: number;
    donorExternalIdField: string;
    donorExternalIdColumn: string;
    donorEmailColumn: string;
    donorNameField: string;
    donorLinkColumn: string;
    emailFieldPrecedence: string[];
    statusField: string;
    statusValueMap: Record<string, string>;
    doNotMigrateFields: string[];
  };
  subscriptionsPoll: SubscriptionsPollConfig;
}

// Bindings (DB, queues, rate limiters) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets and narrowed queue message types are declared here.
export interface Env extends Cloudflare.Env {
  WRITE_QUEUE: Queue<FunraiseQueueMessage>;
  MONDAY_API_TOKEN: string;
  // Shared secret required as `?secret=...` on the registered Funraise webhook URL
  // (`wrangler secret put FUNRAISE_WEBHOOK_SECRET`). Optional in the type because
  // secrets aren't declared in wrangler.jsonc — the webhook route fails closed
  // (401 on every delivery) until it is set.
  FUNRAISE_WEBHOOK_SECRET?: string;
  // Funraise REST API key (`wrangler secret put FUNRAISE_API_KEY`), used only by the
  // subscriptions poller and the consumer's never-seen-subscription lookup. Optional for the
  // same reason; the poll logs and skips until it is set.
  FUNRAISE_API_KEY?: string;
}
