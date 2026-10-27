import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector } from './environment';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1OrderStore } from './db/orders';
import { D1EventStore } from './db/events';
import { D1AttendeeStore } from './db/attendees';
import { HttpEventbriteClient } from './eventbrite/client';
import { HttpMondayClient } from './monday/client';
import { processOrderQueueBatch, type WriteQueueMessage } from './consumer/processBatch';
import { runFollowups, type FollowupResult } from './followups/run';
import { errorMessage } from './util/errorMessage';
import { processDeadLetters } from './consumer/processDeadLetters';
import { checkRequestRateLimit } from './rateLimit';
import type { Env } from './types';

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

// One line per sweep for Workers Logs. A failed event is an error (its Follow-ups stays blank, so
// the next hourly run retries it); a clean sweep is just info.
export function logFollowupSummary(result: FollowupResult): void {
  const counts = `sent ${result.sent.length}, held ${result.held.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`;
  if (result.failed.length > 0) console.error(`eventbrite-sync follow-ups: ${counts} (${result.failed.join(', ')})`);
  else console.log(`eventbrite-sync follow-ups: ${counts}`);
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
    await processOrderQueueBatch([...batch.messages], {
      orderStore,
      eventStore,
      attendeeStore,
      queue: { send: (message: WriteQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined) },
      eventbriteClient: new HttpEventbriteClient(config.eventbrite.apiUrl, token),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
    });
  },

  // Hourly (wrangler.jsonc triggers): the morning-after class follow-ups. Cheap when idle: one D1
  // read of events that ended in the last few days, and Monday is touched only for those.
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return runScheduled(controller, env, ctx, runFollowups);
  },
};

// `run` is a parameter so a test can observe the call without module mocking.
export async function runScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext, run: typeof runFollowups): Promise<void> {
  const config = configFor(env);
  const token = env.MONDAY_API_TOKEN;
  if (token === undefined || token === '') {
    throw new Error('MONDAY_API_TOKEN is not set (wrangler secret put MONDAY_API_TOKEN); cannot run class follow-ups');
  }
  ctx.waitUntil(
    run(new Date(controller.scheduledTime), {
      eventStore: new D1EventStore(env.DB),
      attendeeStore: new D1AttendeeStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, token),
      config,
    })
      .then(logFollowupSummary)
      // A sweep-level throw (config, D1) must be logged, not become an unhandled waitUntil rejection.
      .catch((err) => console.error(`eventbrite-sync follow-ups: sweep failed: ${errorMessage(err)}`))
  );
}
