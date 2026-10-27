import { Hono } from 'hono';
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { validateConfig } from './config';
import { consumeSyncBatch } from './consumer/processBatch';
import { processDeadLetters } from './consumer/processDeadLetters';
import { D1MapStore } from './db/map';
import { D1MondayEventStore } from './db/mondayEvents';
import { D1QbEventStore } from './db/qbEvents';
import { createConfigSelector, environmentOf } from './environment';
import { DEFAULT_PII_KEYS, readLogLevel, readWriteMode } from './flags';
import type { BatchSkipContext } from './writeSwitch';
import { HttpMondayClient } from './monday/client';
import { createMondayWebhookApp } from './monday/webhook/route';
import { HttpQuickBooksClient } from './quickbooks/client';
import { D1TokenStore } from './quickbooks/tokenStore';
import { createQbWebhookApp, type QueueLike } from './quickbooks/webhook/route';
import { checkRequestRateLimit } from './rateLimit';
import type { Env, QueueMessage } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

// Must match the dead_letter_queue names in wrangler.jsonc: the production name at the top level
// and the same name with "-sandbox" before "-dlq" under env.sandbox (same shape as
// donation-rollups and funraise-sync). Exported for tests.
const DEAD_LETTER_QUEUE = 'quickbooks-sync-writes-dlq';
const SANDBOX_DEAD_LETTER_QUEUE = 'quickbooks-sync-writes-sandbox-dlq';

export function isDeadLetterBatch(queueName: string): boolean {
  return queueName === DEAD_LETTER_QUEUE || queueName === SANDBOX_DEAD_LETTER_QUEUE;
}

const WORKER = 'quickbooks-sync';

// The mode and log level, read once per queue batch (never cached per isolate, so a flip reaches
// the next batch within the KV edge cache's 30 seconds).
async function skipContext(env: Env): Promise<BatchSkipContext> {
  const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
  return { worker: WORKER, environment: environmentOf(env), mode, logLevel, piiKeys: DEFAULT_PII_KEYS };
}

// env.SYNC_QUEUE is a Cloudflare Queue<QueueMessage>, whose send() resolves to a
// QueueSendResponse rather than void. Adapt it to the QueueLike interface shared by
// the webhook routes (Task 11/13), which only needs fire-and-forget enqueueing.
function toQueueLike(queue: Queue<QueueMessage>): QueueLike {
  return {
    async send(message: QueueMessage): Promise<void> {
      await queue.send(message);
    },
  };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // configFor validates synchronously and must keep throwing synchronously (before any
    // routing or rate-limit check) on a misconfigured ENVIRONMENT — see index.test.ts.
    const config = configFor(env);

    // Checked before any routing, D1, or Monday/QuickBooks work — see README "Reliability:
    // traffic and cost limits". REQUEST_RATE_LIMITER is provisioned in wrangler.jsonc.
    return checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }).then((limited) => {
      if (limited) return limited;

      const mapStore = new D1MapStore(env.DB);
      const queue = toQueueLike(env.SYNC_QUEUE);

      // Neither webhook route calls QuickBooks or Monday: they record and enqueue, and the queue
      // consumer below does every outbound call (#33).
      const app = new Hono();
      app.route(
        '/',
        createQbWebhookApp({
          qbEventStore: new D1QbEventStore(env.DB),
          queue,
          verifierToken: env.QB_WEBHOOK_VERIFIER_TOKEN,
          connectedRealmId: async () => (await new D1TokenStore(env.DB).getTokens())?.realmId ?? null,
          writeMode: () => readWriteMode(env, WORKER),
        })
      );
      app.route(
        '/',
        createMondayWebhookApp({
          mondayEventStore: new D1MondayEventStore(env.DB),
          mapStore,
          queue,
          config,
          mondayWebhookSecret: env.MONDAY_WEBHOOK_SECRET,
          writeMode: () => readWriteMode(env, WORKER),
        })
      );

      return app.fetch(request, env, ctx);
    });
  },

  // Both the write queue and its dead-letter queue are consumed here; wrangler.jsonc names them.
  // The dead-letter consumer only stamps D1 bookkeeping, so it runs in every write mode.
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    if (isDeadLetterBatch(batch.queue)) {
      await processDeadLetters([...batch.messages], {
        qbEventStore: new D1QbEventStore(env.DB),
        mondayEventStore: new D1MondayEventStore(env.DB),
      });
      return;
    }
    const gate = await skipContext(env);
    await consumeSyncBatch([...batch.messages], {
      qbEventStore: new D1QbEventStore(env.DB),
      mondayEventStore: new D1MondayEventStore(env.DB),
      mapStore: new D1MapStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      quickBooksClient: new HttpQuickBooksClient(
        new D1TokenStore(env.DB),
        env.QB_CLIENT_ID,
        env.QB_CLIENT_SECRET,
        config.quickbooks.apiBaseUrl
      ),
      config,
    }, gate);
  },
};
