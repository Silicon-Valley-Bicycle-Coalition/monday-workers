import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1PendingStore } from './db/pending';
import { D1DonationLinksStore } from './db/links';
import { D1GiftsStore } from './db/gifts';
import { HttpMondayClient } from './monday/client';
import { processRecomputeBatch } from './consumer/processBatch';
import { runDuty, dutiesForDate, type CustodianDeps } from './custodian/custodian';
import { createCustodianApp } from './custodian/routes';
import type { Env, RecomputeQueueMessage } from './types';

const config = validateConfig(rawConfig);

function custodianDeps(env: Env): CustodianDeps {
  return {
    gifts: new D1GiftsStore(env.DB),
    mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
    queue: {
      sendBatch: (messages: RecomputeQueueMessage[]) =>
        env.RECOMPUTE_QUEUE.sendBatch(messages.map((body) => ({ body }))).then(() => undefined),
    },
    config,
  };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname.startsWith('/custodian/')) {
      const deps = custodianDeps(env);
      const app = createCustodianApp({
        runDuty: (duty) => runDuty(duty, deps),
        lastRuns: () => deps.gifts.lastRuns(),
        secret: env.MONDAY_WEBHOOK_SECRET,
      });
      return app.fetch(request, env, ctx);
    }
    const app = createApp({
      pendingStore: new D1PendingStore(env.DB),
      queue: {
        send: (message: RecomputeQueueMessage) => env.RECOMPUTE_QUEUE.send(message).then(() => undefined),
      },
      webhookSecret: env.MONDAY_WEBHOOK_SECRET,
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<RecomputeQueueMessage>, env: Env): Promise<void> {
    await processRecomputeBatch([...batch.messages], {
      pendingStore: new D1PendingStore(env.DB),
      linksStore: new D1DonationLinksStore(env.DB),
      giftsStore: new D1GiftsStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
    });
  },

  // One daily trigger; dutiesForDate decides what today owes (reconcile nightly, capacity
  // Mondays, the July 1 fiscal-year sweep, the July 15 year-end archive run — docs/20 §5.3),
  // consulting the last recorded runs so an incomplete sliced sweep/archive keeps getting
  // continued daily until it reports remaining === 0.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const deps = custodianDeps(env);
    for (const duty of dutiesForDate(new Date(), await deps.gifts.lastRuns())) {
      const report = await runDuty(duty, deps);
      console.log(`custodian ${duty}: ${report.ok ? 'ok' : 'ATTENTION'} — ${report.summary}`);
    }
  },
};
