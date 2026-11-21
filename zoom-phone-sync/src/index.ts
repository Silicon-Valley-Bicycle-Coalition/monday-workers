import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector } from './environment';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1EventStore, type PhoneQueueMessage } from './db/events';
import { D1PhoneIndexStore } from './db/phoneIndex';
import { HttpMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { runNightly } from './phoneIndex/nightly';
import { checkRequestRateLimit, isVerifiedWebhook } from './rateLimit';
import { readWriteMode } from './flags';
import type { Env } from './types';

// This Worker's name in the FLAGS KV keys (`zoom-phone-sync:writes`), as scripts/flags.mjs expects.
export const WORKER = 'zoom-phone-sync';

// One config per environment, chosen from env.ENVIRONMENT and validated once per isolate.
export const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

function queueOf(env: Env) {
  return { sendBatch: (messages: PhoneQueueMessage[]) => env.WRITE_QUEUE.sendBatch(messages.map((body) => ({ body }))).then(() => undefined) };
}

// Ingest (#52) and the nightly phone index (#53). The queue consumer that matches and writes
// Monday is #54; until it lands, wrangler.jsonc declares the producer and nothing consumes it.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = configFor(env);

    if (!(await isVerifiedWebhook(request, env.ZOOM_WEBHOOK_SECRET))) {
      const limited = await checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) });
      if (limited) return limited;
    }

    const app = createApp({
      eventStore: new D1EventStore(env.DB),
      config,
      queue: queueOf(env),
      webhookSecret: env.ZOOM_WEBHOOK_SECRET,
      writeMode: () => readWriteMode(env, WORKER),
    });
    return app.fetch(request, env, ctx);
  },

  // Nightly (wrangler.jsonc triggers): rebuild the phone index, expire and rematch unmatched
  // events. Runs under every write-switch state; it reads Monday and writes only D1 and the queue.
  // A failure throws, so the run shows as failed and yesterday's index stays for tomorrow's run.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const summary = await runNightly({
      monday: new HttpMondayClient(tokenProviderFor(env)),
      store: new D1PhoneIndexStore(env.DB),
      queue: queueOf(env),
      config: configFor(env),
      writeMode: () => readWriteMode(env, WORKER),
    });
    // Counts only: never a number or an item id.
    console.log(`zoom-phone-sync nightly: ${JSON.stringify(summary)}`);
  },
} satisfies ExportedHandler<Env>;
