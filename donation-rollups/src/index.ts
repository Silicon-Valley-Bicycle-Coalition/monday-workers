import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, environmentOf, queueBaseName } from './environment';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1PendingStore } from './db/pending';
import { D1DonationLinksStore } from './db/links';
import { D1GiftsStore } from './db/gifts';
import { D1VolunteerActivityStore } from './db/volunteerActivity';
import { D1OwnerRecomputesStore } from './db/ownerRecomputes';
import { D1RollCallCreditsStore } from './db/rollCallCredits';
import { D1AffiliationsStore } from './db/affiliations';
import { HttpMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { consumeRecomputeBatch } from './consumer/processBatch';
import { processDeadLetters } from './consumer/processDeadLetters';
import { runDuty, runScheduled, type CustodianDeps } from './custodian/custodian';
import { createCustodianApp } from './custodian/routes';
import { checkRequestRateLimit, isVerifiedMondayWebhook } from './rateLimit';
import { DEFAULT_PII_KEYS, readLogLevel, readWriteMode } from './flags';
import { custodianDepsFor, type BatchSkipContext } from './writeSwitch';
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

const WORKER = 'donation-rollups';

// The write switch's mode and log level, read once per queue batch, cron run or duty request
// (never cached per isolate, so a flip reaches the next one within the KV edge cache's 30 s).
async function skipContext(env: Env): Promise<BatchSkipContext> {
  const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
  return { worker: WORKER, environment: environmentOf(env), mode, logLevel, piiKeys: DEFAULT_PII_KEYS };
}

function custodianDeps(env: Env): CustodianDeps {
  const config = configFor(env);
  return {
    gifts: new D1GiftsStore(env.DB),
    pending: new D1PendingStore(env.DB),
    volunteers: new D1VolunteerActivityStore(env.DB),
    recomputes: new D1OwnerRecomputesStore(env.DB),
    rollCallCredits: new D1RollCallCreditsStore(env.DB),
    mondayClient: new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
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
    // cost limits". Covers both branches below, except a Monday webhook delivery that already
    // passed verification (issue #27 — Monday's own bulk-edit traffic must not be throttled).
    // REQUEST_RATE_LIMITER is provisioned in wrangler.jsonc.
    return isVerifiedMondayWebhook(request, env.MONDAY_WEBHOOK_SECRET).then((verified) => verified
      ? null
      : checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }),
    ).then((limited) => {
      if (limited) return limited;

      if (new URL(request.url).pathname.startsWith('/custodian/')) {
        const deps = custodianDeps(env);
        // Read once for this request, and only by a duty run (not by /custodian/status).
        let gate: Promise<BatchSkipContext> | undefined;
        const gateOnce = () => (gate ??= skipContext(env));
        const app = createCustodianApp({
          runDuty: async (duty, opts, disposition) => runDuty(duty,
            custodianDepsFor(disposition, deps, { ...(await gateOnce()), deliveryId: `custodian:${duty}:${new Date().toISOString()}` }), opts),
          lastRuns: () => deps.gifts.lastRuns(),
          secret: env.CUSTODIAN_SECRET,
          writeMode: async () => (await gateOnce()).mode,
        });
        return app.fetch(request, env, ctx);
      }
      const app = createApp({
        pendingStore: new D1PendingStore(env.DB),
        donationBoardIds: new Set(config.donationRollups.donationBoards.map((b) => String(b.boardId))),
        registrationBoards: new Map(config.donationRollups.volunteerBoards.map((b) => [String(b.boardId),
          new Set([b.columns.attendee, b.columns.event, b.columns.attendance, b.columns.role, ...(b.columns.hours ? [b.columns.hours] : [])])])),
        ignoredColumnIds: new Set(config.donationRollups.donationBoards.flatMap((b) =>
          b.columns.classification ? Object.values(b.columns.classification).map((col) => `${b.boardId}:${col}`) : [])),
        queue: {
          send: (message: RecomputeQueueMessage) => env.RECOMPUTE_QUEUE.send(message).then(() => undefined),
        },
        webhookSecret: env.MONDAY_WEBHOOK_SECRET,
        writeMode: () => readWriteMode(env, WORKER),
      });
      return app.fetch(request, env, ctx);
    });
  },

  // Both queues are consumed by this one Worker; wrangler.jsonc's consumers list names them.
  // The dead-letter consumer runs before any write-switch read and in every mode: it marks
  // pending rows failed and raises the alert a human needs (src/consumer/processDeadLetters.ts).
  async queue(batch: MessageBatch<RecomputeQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    if (isDeadLetterBatch(batch.queue)) {
      await processDeadLetters([...batch.messages], {
        pendingStore: new D1PendingStore(env.DB),
        mondayClient: new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
        config,
      });
      return;
    }
    const gate = await skipContext(env);
    await consumeRecomputeBatch([...batch.messages], {
      pendingStore: new D1PendingStore(env.DB),
      linksStore: new D1DonationLinksStore(env.DB),
      giftsStore: new D1GiftsStore(env.DB),
      volunteerStore: new D1VolunteerActivityStore(env.DB),
      recomputesStore: new D1OwnerRecomputesStore(env.DB),
      affiliationsStore: new D1AffiliationsStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
      config,
      queue: { send: (message: RecomputeQueueMessage) => env.RECOMPUTE_QUEUE.send(message).then(() => undefined) },
    }, gate);
  },

  // One daily trigger; dutiesForDate decides what today owes (reconcile nightly, capacity
  // Mondays, the July 1 fiscal-year sweep, the July 15 year-end archive run — docs/20 §5.3),
  // consulting the last recorded runs so an incomplete sliced sweep/archive keeps getting
  // continued daily until it reports remaining === 0. The write switch gates the whole run
  // (custodian.ts runScheduled).
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduled(custodianDeps(env), await skipContext(env));
  },
};
