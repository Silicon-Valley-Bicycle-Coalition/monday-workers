import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, environmentOf } from './environment';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1OrderStore } from './db/orders';
import { D1EventStore } from './db/events';
import { D1AttendeeStore } from './db/attendees';
import { D1ClassEmailStore } from './db/classEmails';
import { HttpEventbriteClient } from './eventbrite/client';
import { HttpMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { consumeWriteBatch, type WriteQueueMessage } from './consumer/processBatch';
import { checkMissedOrders, isCheckHour, logMissedOrders } from './missedOrders/check';
import { sweepEndedEvents, type EndedEventSweepResult } from './endedEvents/sweep';
import { errorMessage } from './util/errorMessage';
import { processDeadLetters } from './consumer/processDeadLetters';
import { checkRequestRateLimit } from './rateLimit';
import { DEFAULT_PII_KEYS, readLogLevel, readWriteMode, runDisposition } from './flags';
import { dryRunEndedEventDeps, type BatchSkipContext } from './writeSwitch';
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

// Quiet when there is nothing to re-drive, which is most hours.
function logEndedEventSummary(result: EndedEventSweepResult): void {
  if (result.failed.length > 0) console.error(`eventbrite-sync ended events: queued ${result.queued.length}, failed ${result.failed.length} (${result.failed.join(', ')})`);
  else if (result.queued.length > 0) console.log(`eventbrite-sync ended events: queued ${result.queued.length}`);
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
        eventStore: new D1EventStore(env.DB),
        attendeeStore: new D1AttendeeStore(env.DB),
        config,
        queue: {
          send: (message: WriteQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined),
        },
        webhookSecret: env.EVENTBRITE_WEBHOOK_SECRET,
        writeMode: () => readWriteMode(env, WORKER),
        classEmails: {
          store: new D1ClassEmailStore(env.DB),
          // A plain client, never the write switch's dry-run wrapper: the routes make no Monday
          // write unless the mode is `on`. Built only after the secret passes.
          mondayClient: () => new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
          secret: env.CLASS_EMAIL_SECRET,
        },
      });
      return app.fetch(request, env, ctx);
    });
  },

  // Both the write queue and its dead-letter queue are consumed here; wrangler.jsonc names them.
  async queue(batch: MessageBatch<WriteQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    const orderStore = new D1OrderStore(env.DB);
    const eventStore = new D1EventStore(env.DB);
    const attendeeStore = new D1AttendeeStore(env.DB);
    if (isDeadLetterBatch(batch.queue)) {
      await processDeadLetters([...batch.messages], { orderStore, eventStore, attendeeStore });
      return;
    }
    // An unset token fails every message (retry, then DLQ) rather than being skipped silently:
    // these are gifts and registrations, and the dead-letter line names the cause.
    const token = env.EVENTBRITE_PRIVATE_TOKEN;
    if (token === undefined || token === '') {
      throw new Error('EVENTBRITE_PRIVATE_TOKEN is not set (wrangler secret put EVENTBRITE_PRIVATE_TOKEN); cannot fetch from Eventbrite');
    }
    const gate = await skipContext(env);
    await consumeWriteBatch([...batch.messages], {
      orderStore,
      eventStore,
      attendeeStore,
      queue: {
        send: (message: WriteQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined),
        sendBatch: (messages: WriteQueueMessage[]) => env.WRITE_QUEUE.sendBatch(messages.map((body) => ({ body }))).then(() => undefined),
      },
      eventbriteClient: new HttpEventbriteClient(config.eventbrite.apiUrl, token),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
      config,
    }, gate);
  },

  // Hourly (wrangler.jsonc triggers): the ended-event status sweep (src/endedEvents/sweep.ts), cheap
  // when idle at one D1 read, and once a day the missed-order check (src/missedOrders/check.ts).
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return runScheduled(controller, env, ctx);
  },
};

// `check` and `sweep` are parameters so a test can observe the calls without module mocking.
export async function runScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  check: typeof checkMissedOrders = checkMissedOrders,
  sweep: typeof sweepEndedEvents = sweepEndedEvents
): Promise<void> {
  const config = configFor(env);
  const now = new Date(controller.scheduledTime);
  // The write switch, read once for this cron run. Both jobs follow runDisposition: `on` runs them;
  // `off` dry-runs the sweep (each queue send logged, none made) and runs the check, which only reads
  // Eventbrite and the orders ledger and logs, so its dry run is the live run; `hold` or an unreadable
  // switch skips them with one line.
  const gate = await skipContext(env);
  const disposition = runDisposition(gate.mode);
  const isCheck = isCheckHour(now);
  if (disposition === 'skip') {
    console.warn(`eventbrite-sync scheduled: write mode is "${gate.mode}"; skipping ${isCheck ? 'the ended-event sweep and the missed-order check' : 'the ended-event sweep'}`);
    return;
  }

  const sweepCtx = { ...gate, deliveryId: `ended-events:${now.toISOString()}` };
  const sweepDeps = {
    eventStore: new D1EventStore(env.DB),
    queue: { send: (message: WriteQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined) },
  };
  ctx.waitUntil(
    sweep(now, disposition === 'run' ? sweepDeps : dryRunEndedEventDeps(sweepDeps, sweepCtx))
      .then(logEndedEventSummary)
      // A sweep-level throw (D1) must be logged, not become an unhandled waitUntil rejection.
      .catch((err) => console.error(`eventbrite-sync ended events: sweep failed: ${errorMessage(err)}`))
  );

  if (!isCheck) return;
  const eventbriteToken = env.EVENTBRITE_PRIVATE_TOKEN;
  if (eventbriteToken === undefined || eventbriteToken === '') {
    // Logged, not thrown, so Workers Issues shows it once a day until it's fixed.
    console.error('eventbrite-sync missed orders: EVENTBRITE_PRIVATE_TOKEN is not set (wrangler secret put EVENTBRITE_PRIVATE_TOKEN); check skipped');
    return;
  }
  ctx.waitUntil(
    check(now, {
      lister: new HttpEventbriteClient(config.eventbrite.apiUrl, eventbriteToken),
      ledger: new D1OrderStore(env.DB),
      organizationId: config.eventbrite.organizationId,
    })
      .then(logMissedOrders)
      .catch((err) => console.error(`eventbrite-sync missed orders: check failed: ${errorMessage(err)}`))
  );
}
