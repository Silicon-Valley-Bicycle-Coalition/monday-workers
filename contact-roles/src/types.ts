import type { MondayTokenSource } from './monday/graphql';

// Bindings for the contact-roles Worker. Stateless: no D1, no queues, no HTTP surface.
export interface Env {
  FLAGS: KVNamespace;
  // The monday-auth broker's Staff sync app (SyncToken entrypoint).
  MONDAY_AUTH: MondayTokenSource;
  // "sandbox" under `wrangler deploy --env sandbox`; unset in production.
  ENVIRONMENT?: string;
}
