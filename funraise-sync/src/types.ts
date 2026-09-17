import type { FunraiseQueueMessage } from './consumer/processBatch';

export type EntityType = 'transaction' | 'subscription' | 'pledge' | 'registration';
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
  'event-registrations': number | null;
  'people-live': number | null;
}

export interface FunraiseSyncConfig {
  monday: {
    apiUrl: string;
    boards: MondayBoards;
  };
  funraiseSync: {
    columnMap: {
      transaction: Record<string, string>;
      recurringGift: Record<string, string>;
      registration: Record<string, string>;
    };
    itemNameField: {
      transaction: string;
      recurringGift: string;
      registration: string;
    };
    entityIdField: {
      transaction: string;
      recurringGift: string;
      registration: string;
    };
    // Monday text column on every target board holding the Funraise entity id;
    // enables the consumer's orphan-recovery lookup before create. null disables it.
    entityIdColumn: string | null;
    // Checkbox column on the Donations board, set true on a transaction's first write only —
    // Funraise's own transaction-time donor receipt already covers acknowledgment (migration-plan.md
    // Decisions Needed, Option 2). null disables it. Never set for recurring gifts or registrations.
    thankYouSentColumn: string | null;
    // Text column on the Donations board stamped with giftTypeValue on a transaction's first
    // write only — donation-rollups' membership rule only counts gifts whose Gift Type is in its
    // eligible list (spec 2026-09-15), and staff may later reclassify a gift, so updates never
    // touch it. null disables the stamp.
    giftTypeColumn: string | null;
    giftTypeValue: string;
    // Text column on the Donations board holding the SVBC fiscal year (July–June, named for the
    // calendar year it ends in) that the gift falls in, derived from the transaction's
    // `createdAt` on first write only — it isn't a Funraise field, so columnMap can't map it.
    // salesforce-import stamps the same column on every migrated gift; donation-rollups reads it
    // and derives from Date when blank but never backfills (decision 2026-09-17). null disables it.
    fiscalYearColumn: string | null;
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
}
