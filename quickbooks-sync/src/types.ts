export type EntityType = 'customer' | 'invoice' | 'product';
export type SyncStatus = 'received' | 'fetched' | 'queued' | 'written' | 'failed';

export interface QbEventRow {
  eventId: string;
  entityType: EntityType;
  qbId: string;
  fetchedPayload: string | null;
  status: SyncStatus;
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}

export interface MondayEventRow {
  eventId: string;
  mondayItemId: string;
  rawPayload: string;
  status: SyncStatus;
  qbId: string | null;
  error: string | null;
  receivedAt: string;
  writtenAt: string | null;
}

export interface MapEntry {
  entityType: EntityType;
  qbId: string;
  mondayItemId: string;
  mondayBoardId: number;
  createdAt: string;
}

export interface MondayBoards {
  customers: number | null;
  invoices: number | null;
  products: number | null;
}

export interface QuickbooksSyncConfig {
  monday: {
    apiUrl: string;
    boards: MondayBoards;
  };
  quickbooksSync: {
    columnMap: {
      customer: Record<string, string>;
      invoice: Record<string, string>;
      product: Record<string, string>;
    };
    itemNameField: {
      customer: string;
      invoice: string;
      product: string;
    };
    linkColumn: {
      invoice: string;
    };
    customerCreateFieldMap: Record<string, string>;
  };
}

export type QueueMessage =
  | { direction: 'qb-to-monday'; eventId: string }
  | { direction: 'monday-to-qb'; eventId: string };

// Bindings (DB, queues, rate limiters) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets and narrowed queue message types are declared here.
export interface Env extends Cloudflare.Env {
  SYNC_QUEUE: Queue<QueueMessage>;
  MONDAY_API_TOKEN: string;
  QB_CLIENT_ID: string;
  QB_CLIENT_SECRET: string;
  QB_WEBHOOK_VERIFIER_TOKEN: string;
}
