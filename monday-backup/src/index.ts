import { Hono } from 'hono';
import productionConfig from '../config/backup.json';
import sandboxConfig from '../config/backup.sandbox.json';
import { createConfigSelector } from './environment';
import { runBackup } from './backup';
import { validateConfig } from './config';
import { D1SnapshotRunStore } from './db/runs';
import { GoogleDriveClient } from './drive/client';
import { HttpMondayClient } from './monday/client';
import type { Env } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts. In the sandbox,
// destinationParentFolderId names the sandbox Drive folder; the split test is what keeps that id
// off the production file.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });
const MONDAY_API_URL = 'https://api.monday.com/v2';

// Cron-only Worker with no public surface (see wrangler.jsonc: no routes, workers_dev and
// preview_urls both false) — this app exists only for a `/health` check reachable from
// inside the Cloudflare dashboard/API, not the Internet.
const app = new Hono<{ Bindings: Env }>();
app.get('/health', (c) => c.text('ok'));

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const config = configFor(env);
    await runBackup({
      monday: new HttpMondayClient(MONDAY_API_URL, env.MONDAY_API_TOKEN),
      drive: new GoogleDriveClient({
        clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        privateKeyPem: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
      }),
      runStore: new D1SnapshotRunStore(env.DB),
      config,
      slackWebhookUrl: env.SLACK_WEBHOOK_URL,
      now: () => new Date(),
    });
  },
};
