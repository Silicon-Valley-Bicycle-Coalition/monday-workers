import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, queueBaseName } from './environment';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1PendingStore } from './db/pending';
import { D1DonationLinksStore } from './db/links';
import { D1GiftsStore } from './db/gifts';
import { D1MembershipBaselineStore } from './db/membershipBaseline';
import { D1OwnerRecomputesStore } from './db/ownerRecomputes';
import { D1AffiliationsStore } from './db/affiliations';
import { HttpMondayClient } from './monday/client';
import { processRecomputeBatch } from './consumer/processBatch';
import { processDeadLetters } from './consumer/processDeadLetters';
import { runDuty, dutiesForDate, type CustodianDeps } from './custodian/custodian';
import { createCustodianApp } from './custodian/routes';
import { checkRequestRateLimit } from './rateLimit';
import type { Env, RecomputeQueueMessage } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

// Must match the dead_letter_queue names in wrangler.jsonc: the production name at the top
// level, and the same name with "-sandbox" before "-dlq" under env.sandbox.
const DEAD_LETTER_QUEUE = 'donation-rollups-recompute-dlq';
const SANDBOX_DEAD_LETTER_QUEUE = 'donation-rollups-recompute-sandbox-dlq';

// Exported for tests. Both spellings are accepted so one consumer serves both environments;
// queueBaseName() alone is not enough because the sandbox suffix sits before "-dlq".
export function isDeadLetterBatch(queueName: string): boolean {
  return queueName === DEAD_LETTER_QUEUE || queueName === SANDBOX_DEAD_LETTER_QUEUE || queueBaseName(queueName) === DEAD_LETTER_QUEUE;
}

function custodianDeps(env: Env): CustodianDeps {
  const config = configFor(env);
  return {
    gifts: new D1GiftsStore(env.DB),
    pending: new D1PendingStore(env.DB),
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
    // configFor validates synchronously and must keep throwing synchronously (before any
    // routing or rate-limit check) on a misconfigured ENVIRONMENT.
    const config = configFor(env);

    // Checked before any routing, D1, or Monday work — see README "Reliability: traffic and
    // cost limits". Covers both branches below. REQUEST_RATE_LIMITER is provisioned in
    // wrangler.jsonc.
    return checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }).then((limited) => {
      if (limited) return limited;

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
        donationBoardIds: new Set(config.donationRollups.donationBoards.map((b) => String(b.boardId))),
        queue: {
          send: (message: RecomputeQueueMessage) => env.RECOMPUTE_QUEUE.send(message).then(() => undefined),
        },
        webhookSecret: env.MONDAY_WEBHOOK_SECRET,
      });
      return app.fetch(request, env, ctx);
    });
  },

  // Both queues are consumed by this one Worker; wrangler.jsonc's consumers list names them.
  async queue(batch: MessageBatch<RecomputeQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    if (isDeadLetterBatch(batch.queue)) {
      await processDeadLetters([...batch.messages], {
        pendingStore: new D1PendingStore(env.DB),
        mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
        config,
      });
      return;
    }
    await processRecomputeBatch([...batch.messages], {
      pendingStore: new D1PendingStore(env.DB),
      linksStore: new D1DonationLinksStore(env.DB),
      giftsStore: new D1GiftsStore(env.DB),
      baselineStore: new D1MembershipBaselineStore(env.DB),
      recomputesStore: new D1OwnerRecomputesStore(env.DB),
      affiliationsStore: new D1AffiliationsStore(env.DB),
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
