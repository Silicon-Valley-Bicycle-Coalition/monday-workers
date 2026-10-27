import type { WriteStamp } from './flags';
export type EntityType = 'customer' | 'invoice' | 'product';
export type SyncStatus = 'received' | 'fetched' | 'queued' | 'written' | 'failed';

export interface QbEventRow {
  eventId: string;
  entityType: EntityType;
  qbId: string;
  fetchedPayload: string | null;
  pendingMondayItemId: string | null;
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
  // Terminal create failures so far (migration 0005); part of the create's Intuit requestid.
  createAttempt: number;
  // Creates sent to Intuit under the current requestid (migration 0006).
  createSends: number;
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
  quickbooks: {
    // QuickBooks Online Accounting API base (…/v3/company). Production is
    // https://quickbooks.api.intuit.com/v3/company; the sandbox environment points at Intuit's
    // sandbox host so a sandbox deploy can never create a Customer in the real company.
    apiBaseUrl: string;
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
    // Id of the Customers board's text column holding the QuickBooks Customer Id (#33 review).
    // Written on every QuickBooks -> Monday customer create/update and after every Monday ->
    // QuickBooks create, so an item that already stands for a QuickBooks Customer says so on
    // the item itself — the create-loop guard reads it. null until staff add the column; while
    // null, Monday -> QuickBooks Customer creates are refused (they can't be made loop-safe).
    customerQbIdColumn: string | null;
  };
}

// The optional stamp is the write switch's (src/flags.ts): a message enqueued while writes were
// `off` stays a dry run even if the mode is `on` by the time it is consumed.
export type QueueMessage = (
  | { direction: 'qb-to-monday'; eventId: string }
  | { direction: 'monday-to-qb'; eventId: string }
) &
  WriteStamp;

// Bindings (DB, queues, rate limiters) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets and narrowed queue message types are declared here.
export interface Env extends Cloudflare.Env {
  SYNC_QUEUE: Queue<QueueMessage>;
  MONDAY_API_TOKEN: string;
  QB_CLIENT_ID: string;
  QB_CLIENT_SECRET: string;
  QB_WEBHOOK_VERIFIER_TOKEN: string;
  MONDAY_WEBHOOK_SECRET: string;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
}
