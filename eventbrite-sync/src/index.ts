import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, environmentOf } from './environment';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1OrderStore } from './db/orders';
import { HttpEventbriteClient } from './eventbrite/client';
import { HttpMondayClient } from './monday/client';
import { consumeOrderBatch, type OrderQueueMessage } from './consumer/processBatch';
import { processDeadLetters } from './consumer/processDeadLetters';
import { checkRequestRateLimit } from './rateLimit';
import { DEFAULT_PII_KEYS, readLogLevel, readWriteMode } from './flags';
import type { BatchSkipContext } from './writeSwitch';
import type { Env } from './types';

// This Worker's name in the FLAGS KV keys (`eventbrite-sync:writes`, `eventbrite-sync:log`) — the
// directory name, as scripts/flags.mjs expects.
const WORKER = 'eventbrite-sync';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

// Must match the dead_letter_queue names in wrangler.jsonc: the production name at the top level
// and the same name with "-sandbox" before "-dlq" under env.sandbox. Exported for tests.
const DEAD_LETTER_QUEUE = 'eventbrite-sync-writes-dlq';
const SANDBOX_DEAD_LETTER_QUEUE = 'eventbrite-sync-writes-sandbox-dlq';

export function isDeadLetterBatch(queueName: string): boolean {
  return queueName === DEAD_LETTER_QUEUE || queueName === SANDBOX_DEAD_LETTER_QUEUE;
}

// The mode and log level, read once per queue batch (never cached per isolate, so a flip reaches
// the next batch within the KV edge cache's 30 seconds).
async function skipContext(env: Env): Promise<BatchSkipContext> {
  const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
  return { worker: WORKER, environment: environmentOf(env), mode, logLevel, piiKeys: DEFAULT_PII_KEYS };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // configFor validates synchronously and must keep throwing synchronously (before any
    // routing or rate-limit check) on a misconfigured ENVIRONMENT — see index.test.ts.
    const config = configFor(env);

    // Checked before any routing, D1, or Monday work — see the root README "Reliability: traffic
    // and cost limits". REQUEST_RATE_LIMITER is provisioned in wrangler.jsonc.
    return checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }).then((limited) => {
      if (limited) return limited;

      const app = createApp({
        orderStore: new D1OrderStore(env.DB),
        config,
        queue: {
          send: (message: OrderQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined),
        },
        webhookSecret: env.EVENTBRITE_WEBHOOK_SECRET,
        writeMode: () => readWriteMode(env, WORKER),
      });
      return app.fetch(request, env, ctx);
    });
  },

  // Both the write queue and its dead-letter queue are consumed here; wrangler.jsonc names them.
  async queue(batch: MessageBatch<OrderQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    const orderStore = new D1OrderStore(env.DB);
    if (isDeadLetterBatch(batch.queue)) {
      await processDeadLetters([...batch.messages], { orderStore });
      return;
    }
    // An unset token fails every message (retry, then DLQ) rather than being skipped silently:
    // these are gifts, and the dead-letter line names the cause.
    const token = env.EVENTBRITE_PRIVATE_TOKEN;
    if (token === undefined || token === '') {
      throw new Error('EVENTBRITE_PRIVATE_TOKEN is not set (wrangler secret put EVENTBRITE_PRIVATE_TOKEN); cannot fetch orders');
    }
    const gate = await skipContext(env);
    await consumeOrderBatch([...batch.messages], {
      orderStore,
      eventbriteClient: new HttpEventbriteClient(config.eventbrite.apiUrl, token),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
    }, gate);
  },
};
