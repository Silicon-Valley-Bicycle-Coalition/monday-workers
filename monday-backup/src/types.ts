export interface BoardSummary {
  id: string;
  name: string;
  workspaceId: string | null;
}

export interface ColumnDef {
  id: string;
  title: string;
  type: string;
  settingsStr: string;
}

export interface GroupDef {
  id: string;
  title: string;
}

export interface ColumnValue {
  id: string;
  text: string | null;
  value: string | null;
}

export interface ItemRecord {
  id: string;
  name: string;
  groupId: string | null;
  columnValues: ColumnValue[];
}

export interface DocSummary {
  id: string;
  name: string;
  workspaceId: string | null;
  url: string | null;
}

export interface DocBlock {
  id: string;
  type: string;
  content: string | null;
}

export interface BackupConfig {
  destinationParentFolderId: string;
  excludeBoardIds: string[];
}

// Bindings (D1, etc.) come from the generated Cloudflare.Env
// (`npm run typecheck` regenerates worker-configuration.d.ts from wrangler.jsonc);
// only secrets are declared here.
export interface Env extends Cloudflare.Env {
  MONDAY_API_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  SLACK_WEBHOOK_URL: string;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
}
