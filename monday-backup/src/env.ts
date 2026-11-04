import type { MondayTokenSource } from './monday/graphql';

// The Worker's environment. Kept apart from src/types.ts so the snapshot types stay free of the
// Workers runtime and can be shared with the Node restore CLI (scripts/restore.ts).
//
// Bindings (D1, etc.) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets and MONDAY_AUTH are declared here. MONDAY_AUTH is generated as an untyped Service,
// so it is omitted and restated as the broker's RPC shape.
export interface Env extends Omit<Cloudflare.Env, 'MONDAY_AUTH'> {
  // Write-switch flags KV (src/flags.ts).
  FLAGS: KVNamespace;
  // Monday access: the monday-auth broker's ReadOnlyToken entrypoint (wrangler.jsonc services). The
  // fixed MONDAY_API_TOKEN secret is only the fallback while the OAuth cutover is under way;
  // tokenProviderFor (src/monday/graphql.ts) prefers the binding and throws if neither is set.
  // The restore CLI (scripts/restore.ts) keeps reading MONDAY_API_TOKEN from the operator's shell.
  MONDAY_AUTH?: MondayTokenSource;
  MONDAY_API_TOKEN?: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  SLACK_WEBHOOK_URL: string;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
}
