import type { MondayTokenSource } from './monday/graphql';

// Bindings for the impact-attribution Worker. Cron only: no queue, no HTTP surface.
export interface Env {
  // Match history and the proposals ledger.
  DB: D1Database;
  FLAGS: KVNamespace;
  // The monday-auth broker's Staff sync app (SyncToken entrypoint).
  MONDAY_AUTH: MondayTokenSource;
  // "sandbox" under `wrangler deploy --env sandbox`; unset in production.
  ENVIRONMENT?: string;
}
