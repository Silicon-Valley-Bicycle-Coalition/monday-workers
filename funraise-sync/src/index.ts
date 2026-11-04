import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, environmentOf } from './environment';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1EventStore } from './db/events';
import { D1SubscriptionStore } from './db/subscriptions';
import { HttpFunraiseClient } from './funraise/client';
import { HttpMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { consumeFunraiseBatch, type FunraiseQueueMessage } from './consumer/processBatch';
import { processDeadLetters } from './consumer/processDeadLetters';
import { pollSubscriptions } from './subscriptions/poll';
import { dispatchScheduled } from './scheduled';
import { checkRequestRateLimit } from './rateLimit';
import { DEFAULT_PII_KEYS, readLogLevel, readWriteMode } from './flags';
import { pollDepsFor, type BatchSkipContext } from './writeSwitch';
import type { Env } from './types';

// This Worker's name in the FLAGS KV keys (`funraise-sync:writes`, `funraise-sync:log`) — the
// directory name, as scripts/flags.mjs expects.
const WORKER = 'funraise-sync';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

// Funraise's REST API host; the reference's "Live Server". Only the subscriptions poller and the
// consumer's never-seen-subscription lookup talk to it.
const FUNRAISE_API_URL = 'https://api.funraise.io';

// Must match the dead_letter_queue names in wrangler.jsonc: the production name at the top level
// and the same name with "-sandbox" before "-dlq" under env.sandbox (same shape as
// donation-rollups). Exported for tests.
const DEAD_LETTER_QUEUE = 'funraise-sync-writes-dlq';
const SANDBOX_DEAD_LETTER_QUEUE = 'funraise-sync-writes-sandbox-dlq';

export function isDeadLetterBatch(queueName: string): boolean {
  return queueName === DEAD_LETTER_QUEUE || queueName === SANDBOX_DEAD_LETTER_QUEUE;
}

// The mode and log level, read once per queue batch or cron run (never cached per isolate, so a
// flip reaches the next batch within the KV edge cache's 30 seconds).
async function skipContext(env: Env): Promise<BatchSkipContext> {
  const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
  return { worker: WORKER, environment: environmentOf(env), mode, logLevel, piiKeys: DEFAULT_PII_KEYS };
}

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
        writeMode: () => readWriteMode(env, WORKER),
      });
      return app.fetch(request, env, ctx);
    });
  },

  // Both the write queue and its dead-letter queue are consumed here; wrangler.jsonc names them.
  // The dead-letter consumer only stamps D1 bookkeeping, so it runs in every write mode.
  async queue(batch: MessageBatch<FunraiseQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    if (isDeadLetterBatch(batch.queue)) {
      await processDeadLetters([...batch.messages], { eventStore: new D1EventStore(env.DB) });
      return;
    }
    const gate = await skipContext(env);
    await consumeFunraiseBatch([...batch.messages], {
      eventStore: new D1EventStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
      config,
      subscriptionStore: new D1SubscriptionStore(env.DB),
      funraiseClient: funraiseClient(env),
    }, gate);
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const config = configFor(env);
    const gate = await skipContext(env);
    await dispatchScheduled(controller.cron, {
      writeMode: gate.mode,
      pollEnabled: config.subscriptionsPoll.enabled,
      apiKeyPresent: env.FUNRAISE_API_KEY !== undefined && env.FUNRAISE_API_KEY !== '',

      // Hourly: Recurring Gifts board ← Funraise subscriptions (spec 2026-09-18).
      // Under `off` it dry-runs (pollDepsFor): Monday writes and ledger rows are logged and
      // dropped, but the cursor advances.
      poll: async (disposition) => {
        const client = funraiseClient(env);
        if (!client) return;
        const deliveryId = `subscriptions-poll@${new Date(controller.scheduledTime).toISOString()}`;
        const live = {
          funraiseClient: client,
          subscriptionStore: new D1SubscriptionStore(env.DB),
          mondayClient: new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
          config,
          maxPages: config.subscriptionsPoll.maxPagesPerRun,
        };
        const result = await pollSubscriptions(pollDepsFor(disposition, live, { ...gate, deliveryId }));
        console.log(
          `funraise-sync scheduled: subscriptions poll${disposition === 'dry-run' ? ' (dry run, nothing written)' : ''} read ${result.rows} rows over ${result.pages} pages — created ${result.actions.created}, adopted ${result.actions.adopted}, updated ${result.actions.updated}, unchanged ${result.actions.noop}; cursor ${result.cursor}${result.tieId === null ? '' : ` (tie walk at id > ${result.tieId})`}${result.caughtUp ? ', caught up' : ''}`
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
