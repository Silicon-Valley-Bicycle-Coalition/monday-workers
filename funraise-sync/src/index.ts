import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1EventStore } from './db/events';
import { D1SubscriptionStore } from './db/subscriptions';
import { HttpFunraiseClient } from './funraise/client';
import { HttpMondayClient } from './monday/client';
import { processFunraiseQueueBatch, type FunraiseQueueMessage } from './consumer/processBatch';
import { pollSubscriptions } from './subscriptions/poll';
import { dispatchScheduled } from './scheduled';
import type { Env } from './types';

const config = validateConfig(rawConfig);

// Funraise's REST API host; the reference's "Live Server". Only the subscriptions poller and the
// consumer's never-seen-subscription lookup talk to it.
const FUNRAISE_API_URL = 'https://api.funraise.io';

function funraiseClient(env: Env): HttpFunraiseClient | undefined {
  return env.FUNRAISE_API_KEY ? new HttpFunraiseClient(FUNRAISE_API_URL, env.FUNRAISE_API_KEY) : undefined;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = createApp({
      eventStore: new D1EventStore(env.DB),
      config,
      queue: {
        send: (message: FunraiseQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined),
      },
      webhookSecret: env.FUNRAISE_WEBHOOK_SECRET,
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<FunraiseQueueMessage>, env: Env): Promise<void> {
    await processFunraiseQueueBatch([...batch.messages], {
      eventStore: new D1EventStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
      subscriptionStore: new D1SubscriptionStore(env.DB),
      funraiseClient: funraiseClient(env),
    });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await dispatchScheduled(controller.cron, {
      pollEnabled: config.subscriptionsPoll.enabled,
      apiKeyPresent: env.FUNRAISE_API_KEY !== undefined && env.FUNRAISE_API_KEY !== '',

      // Hourly: Recurring Gifts board ← Funraise subscriptions (spec 2026-09-18).
      poll: async () => {
        const client = funraiseClient(env);
        if (!client) return;
        const result = await pollSubscriptions({
          funraiseClient: client,
          subscriptionStore: new D1SubscriptionStore(env.DB),
          mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
          config,
          maxPages: config.subscriptionsPoll.maxPagesPerRun,
        });
        console.log(
          `funraise-sync scheduled: subscriptions poll read ${result.rows} rows over ${result.pages} pages — created ${result.actions.created}, adopted ${result.actions.adopted}, updated ${result.actions.updated}, unchanged ${result.actions.noop}; cursor ${result.cursor}`
        );
      },

      // Daily PII retention pass: raw Funraise payloads are only kept for replay and
      // debugging, so they are emptied once the write has been in Monday long enough.
      purge: async () => {
        const dayMs = 24 * 60 * 60 * 1000;
        const store = new D1EventStore(env.DB);
        const writtenCutoff = new Date(Date.now() - config.funraiseSync.rawPayloadRetentionDays * dayMs).toISOString();
        const unresolvedCutoff = new Date(
          Date.now() - config.funraiseSync.unresolvedPayloadRetentionDays * dayMs
        ).toISOString();
        const purgedWritten = await store.purgeWrittenPayloads(writtenCutoff);
        const purgedUnresolved = await store.purgeUnresolvedPayloads(unresolvedCutoff);
        if (purgedWritten > 0 || purgedUnresolved > 0) {
          console.log(
            `funraise-sync scheduled: purged raw_payload from ${purgedWritten} written (older than ${writtenCutoff}) and ${purgedUnresolved} unresolved (older than ${unresolvedCutoff}) events`
          );
        }
      },
    });
  },
};
