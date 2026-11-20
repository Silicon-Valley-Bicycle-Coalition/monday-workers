import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector } from './environment';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1EventStore } from './db/events';
import { checkRequestRateLimit, isVerifiedWebhook } from './rateLimit';
import { readWriteMode } from './flags';
import type { Env } from './types';

// This Worker's name in the FLAGS KV keys (`zoom-phone-sync:writes`), as scripts/flags.mjs expects.
export const WORKER = 'zoom-phone-sync';

// One config per environment, chosen from env.ENVIRONMENT and validated once per isolate.
export const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

// Ingest only (#52). The queue consumer that matches and writes Monday is #54 and the nightly
// phone index #53; until they land, wrangler.jsonc declares the producer and nothing consumes it.
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
      queue: { sendBatch: (messages) => env.WRITE_QUEUE.sendBatch(messages.map((body) => ({ body }))).then(() => undefined) },
      webhookSecret: env.ZOOM_WEBHOOK_SECRET,
      writeMode: () => readWriteMode(env, WORKER),
    });
    return app.fetch(request, env, ctx);
  },
};
