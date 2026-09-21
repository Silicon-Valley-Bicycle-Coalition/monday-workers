import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector } from './environment';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1EventStore } from './db/events';
import { D1SubscriptionStore } from './db/subscriptions';
import { HttpFunraiseClient } from './funraise/client';
import { HttpMondayClient } from './monday/client';
import { processFunraiseQueueBatch, type FunraiseQueueMessage } from './consumer/processBatch';
import { pollSubscriptions } from './subscriptions/poll';
import { dispatchScheduled } from './scheduled';
import { checkRequestRateLimit } from './rateLimit';
import type { Env } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

// Funraise's REST API host; the reference's "Live Server". Only the subscriptions poller and the
// consumer's never-seen-subscription lookup talk to it.
const FUNRAISE_API_URL = 'https://api.funraise.io';

function funraiseClient(env: Env): HttpFunraiseClient | undefined {
  return env.FUNRAISE_API_KEY ? new HttpFunraiseClient(FUNRAISE_API_URL, env.FUNRAISE_API_KEY) : undefined;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // configFor validates synchronously and must keep throwing synchronously (before any
    // routing or rate-limit check) on a misconfigured ENVIRONMENT — see index.test.ts.
    const config = configFor(env);

    // Checked before any routing, D1, or Monday work — see README "Reliability: traffic and
    // cost limits". REQUEST_RATE_LIMITER is provisioned in wrangler.jsonc.
    return checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }).then((limited) => {
      if (limited) return limited;

      const app = createApp({
        eventStore: new D1EventStore(env.DB),
        config,
        queue: {
          send: (message: FunraiseQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined),
        },
        webhookSecret: env.FUNRAISE_WEBHOOK_SECRET,
      });
      return app.fetch(request, env, ctx);
    });
  },

  async queue(batch: MessageBatch<FunraiseQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    await processFunraiseQueueBatch([...batch.messages], {
      eventStore: new D1EventStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
      subscriptionStore: new D1SubscriptionStore(env.DB),
      funraiseClient: funraiseClient(env),
    });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const config = configFor(env);
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
