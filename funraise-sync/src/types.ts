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

export interface Env {
  DB: D1Database;
  WRITE_QUEUE: Queue<FunraiseQueueMessage>;
  MONDAY_API_TOKEN: string;
}
