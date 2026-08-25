import { Hono } from 'hono';
import rawConfig from '../config/backup.json';
import { runBackup } from './backup';
import { validateConfig } from './config';
import { D1SnapshotRunStore } from './db/runs';
import { GoogleDriveClient } from './drive/client';
import { HttpMondayClient } from './monday/client';
import type { Env } from './types';

const config = validateConfig(rawConfig);
const MONDAY_API_URL = 'https://api.monday.com/v2';

// Cron-only Worker with no public surface (see wrangler.jsonc: no routes, workers_dev and
// preview_urls both false) — this app exists only for a `/health` check reachable from
// inside the Cloudflare dashboard/API, not the Internet.
const app = new Hono<{ Bindings: Env }>();
app.get('/health', (c) => c.text('ok'));

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
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
