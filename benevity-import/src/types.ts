import type { MondayTokenSource } from './monday/graphql';
import type { BenevityQueueMessage } from './consumer/processBatch';

export interface MondayBoards {
  donations: number | null;
  organizations: number | null;
  people: number | null;
  affiliations: number | null;
  benevityUploads: number | null;
}

export interface DonationsColumns {
  donor: string;
  matchedBy: string;
  amount: string;
  date: string;
  disbursementDate: string;
  fiscalYearEnding: string;
  status: string;
  giftType: string;
  anonymousDonor: string;
  transactionId: string;
}

export interface WorklistColumns {
  reason: string;
  name: string;
  email: string;
  company: string;
  amount: string;
  date: string;
}

// The worklist's staff-facing Retry status column (GL#34). Staff set `retry` on a worklist item
// once they've fixed what it reported; the Worker re-queues the row (or every row of a block)
// and sets `queued`, then `done` once the row is written or `needsReview` if it fails again.
// New worklist items start at `needsReview`. Every label must exist on the column.
export interface RetryColumnConfig {
  column: string;
  labels: {
    needsReview: string;
    retry: string;
    queued: string;
    done: string;
  };
}

export interface UploadsBoardConfig {
  fileColumn: string;
  worklistGroupId: string;
  worklistColumns: WorklistColumns;
  // Text column on the Uploads board holding each worklist item's key (Transaction ID, or
  // "disbursement <id>" for a block) — the pre-create lookup that keeps a retried write from
  // posting a second worklist item (GL#34). Null/absent until the column is provisioned.
  worklistKeyColumn?: string | null;
  // Null/absent until the column exists: retry webhooks are then ignored and no labels written.
  retry?: RetryColumnConfig | null;
}

export interface BenevityImportConfig {
  monday: {
    apiUrl: string;
    // The Monday account a webhook JWT must name (src/mondayJwt.ts). Unset with a signing secret
    // set = every delivery refused.
    accountId?: number;
    boards: MondayBoards;
  };
  benevityImport: {
    // ISO date (YYYY-MM-DD). A disbursement whose Period Ending is before this is skipped whole:
    // it is assumed to be in the migrated Salesforce history, which has no Transaction IDs to
    // dedupe against. Set it to the day after the Period Ending of the last disbursement staff
    // keyed into Salesforce. It gates on the disbursement, never on a row's Donation Date (GL#40):
    // Benevity pays out weeks after the gift, so a new disbursement is full of older-dated rows.
    minDisbursementDate: string;
    donationsColumns: DonationsColumns;
    // Monday's item-name pseudo-column id, used for name-based lookups. Almost always "name".
    organizationsNameColumn: string;
    peopleColumns: {
      personalEmail: string;
      householdEmail: string;
      employer: string;
    };
    affiliationsColumns: {
      person: string;
      organization: string;
      workEmail: string;
      status: string;
    };
    // Only affiliations with this Status count as employer evidence: a Draft is an unconfirmed
    // proposal (impact-attribution, GL#124) and a Former is a past job.
    affiliationsCurrentLabel: string;
    uploadsBoard: UploadsBoardConfig;
    // Raw Benevity "Company" string -> canonical Organizations item name, e.g.
    // {"Google, LLC": "Google"}. A hit here is retried through the same name lookup as an
    // exact match, so it must be case-and-spelling-exact to the target Organization's name.
    organizationAliases: Record<string, string>;
    rawRowRetentionDays: number;
    unresolvedRowRetentionDays: number;
  };
}

// Bindings (DB, queues) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets and narrowed queue message and binding types are declared here. MONDAY_AUTH is
// generated as an untyped Service, so it is omitted and restated as the broker's RPC shape.
export interface Env extends Omit<Cloudflare.Env, 'MONDAY_AUTH'> {
  WRITE_QUEUE: Queue<BenevityQueueMessage>;
  // Monday access: the monday-auth broker's SyncToken entrypoint (wrangler.jsonc services). The
  // fixed MONDAY_API_TOKEN secret is only the fallback while the OAuth cutover is under way;
  // tokenProviderFor (src/monday/graphql.ts) prefers the binding and throws if neither is set.
  MONDAY_AUTH?: MondayTokenSource;
  MONDAY_API_TOKEN?: string;
  // Shared secret required as `?secret=...` on the registered Monday webhook URL
  // (`wrangler secret put BENEVITY_WEBHOOK_SECRET`). Optional in the type because secrets
  // aren't declared in wrangler.jsonc — the webhook route fails closed (401 on every
  // delivery) until it is set, same convention as funraise-sync.
  BENEVITY_WEBHOOK_SECRET?: string;
  // The app's Signing Secret (src/mondayJwt.ts): set = verify any webhook JWT present;
  // MONDAY_WEBHOOK_JWT_REQUIRED = "true" (a var) also rejects deliveries without one.
  MONDAY_SIGNING_SECRET?: string;
  MONDAY_WEBHOOK_JWT_REQUIRED?: string;
  // Which deployment this isolate is — unset (production) or "sandbox". See src/environment.ts.
  ENVIRONMENT?: string;
}
