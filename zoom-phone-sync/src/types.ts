import type { MondayTokenSource } from './monday/graphql';
import type { PhoneQueueMessage } from './db/events';

// config/svbc.json (production) and config/sandbox.json, validated by src/config.ts. Values
// that don't exist yet are null (the SMS tab URL, #50). Ingest needs only `zoom`, the nightly
// index (#53) `people` and the region; the consumer (#54) will refuse to run on a null it needs.
export interface ZoomPhoneSyncConfig {
  people: {
    boardId: number;
    phoneColumn: string;
    lastPhoneContactColumn: string | null;
  };
  timeline: {
    callActivityId: string | null;
    textActivityId: string | null;
  };
  zoom: {
    // payload.account_id every delivery must carry. null skips the check (the signature still
    // authenticates the sender); set it once the S2S app exists.
    accountId: string | null;
    // Staff lines to log, by Zoom user id, email or extension. null = every user on the account;
    // [] = none (the sandbox until its test line is known).
    includeUsers: string[] | null;
    // Staff lines never logged, checked after includeUsers.
    excludeUsers: string[];
    smsUrl: string | null;
  };
  defaultRegion: string;
  unmatchedRetentionDays: number;
}

// Bindings come from the generated Cloudflare.Env (`npm run typecheck`); secrets and narrowed
// binding types are declared here.
export interface Env extends Omit<Cloudflare.Env, 'MONDAY_AUTH'> {
  WRITE_QUEUE: Queue<PhoneQueueMessage>;
  // The monday-auth broker's SyncToken entrypoint: the nightly index reads People with it.
  MONDAY_AUTH?: MondayTokenSource;
  MONDAY_API_TOKEN?: string;
  // The Zoom app's webhook secret token (`wrangler secret put ZOOM_WEBHOOK_SECRET`), used for both
  // the signature check and URL validation. Unset = every delivery is rejected with 401.
  ZOOM_WEBHOOK_SECRET?: string;
  // Set only by wrangler.jsonc's env.sandbox.vars. Unset = production. See src/environment.ts.
  ENVIRONMENT?: string;
}
