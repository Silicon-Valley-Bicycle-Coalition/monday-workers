// The Worker's environment. Kept apart from src/types.ts so the snapshot types stay free of the
// Workers runtime and can be shared with the Node restore CLI (scripts/restore.ts).
//
// Bindings (D1, etc.) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets are declared here.
export interface Env extends Cloudflare.Env {
  // Write-switch flags KV (src/flags.ts).
  FLAGS: KVNamespace;
  MONDAY_API_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  SLACK_WEBHOOK_URL: string;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
}
