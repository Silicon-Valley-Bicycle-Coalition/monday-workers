import { configFor } from './config';
import { handleBatch, RELEASE_SQL } from './consumer';
import { environmentOf } from './environment';
import { runGeocode } from './geocode';
import { readLogLevel, readWriteMode } from './flags';
import { createOsmClient } from './locate/osm';
import { HttpNearbyMondayClient } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { buildApp, WORKER } from './routes';
import type { Env, WriteMessage } from './types';

export type { Env } from './types';

const app = buildApp((env) => {
  const config = configFor(env);
  return {
    config,
    osm: createOsmClient(config.osm),
    // The colo's Cache API carries each board's contact list between a preview and its confirm
    // (client.ts). The cast: this tsconfig also loads the DOM lib, whose CacheStorage has no `default`.
    monday: new HttpNearbyMondayClient(config.monday.apiUrl, tokenProviderFor(env), {}, (caches as unknown as { default: Cache }).default),
  };
});

// Must match the dead_letter_queue names in wrangler.jsonc (production and env.sandbox).
const DEAD_LETTER_QUEUES = new Set(['nearby-search-writes-dlq', 'nearby-search-writes-sandbox-dlq']);
export function isDeadLetterBatch(queueName: string): boolean {
  return DEAD_LETTER_QUEUES.has(queueName);
}

export default {
  fetch: app.fetch,

  // Both the write queue and its dead-letter queue (wrangler.jsonc) are consumed here.
  async queue(batch: MessageBatch<WriteMessage>, env: Env): Promise<void> {
    if (isDeadLetterBatch(batch.queue)) {
      // A write that exhausted its retries: log the ids only (no name, label or address), release
      // a still-pending claim so confirming the search again re-queues the contact, then drop it.
      // A done row (real item id or 'linked') is untouched. If the release fails, retry.
      for (const msg of batch.messages) {
        console.error(JSON.stringify({ worker: WORKER, deadLetter: true, boardId: msg.body.boardId, itemId: msg.body.contactId }));
        try {
          await env.DB.prepare(RELEASE_SQL).bind(String(msg.body.boardId), msg.body.contactId).run();
        } catch {
          msg.retry();
          continue;
        }
        msg.ack();
      }
      return;
    }
    const config = configFor(env);
    // Read once per batch, never cached per isolate, so a flip reaches the next batch.
    const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
    await handleBatch(batch, {
      monday: new HttpNearbyMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
      db: env.DB,
      config,
      mode,
      logLevel,
      environment: environmentOf(env),
    });
  },

  // Hourly geocode backfill. Awaited (not waitUntil) so a failure surfaces as a failed cron run.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const config = configFor(env);
    // Read once per run, never cached per isolate, so a flip reaches the next hour.
    const mode = await readWriteMode(env, WORKER);
    await runGeocode({
      monday: new HttpNearbyMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
      db: env.DB,
      config,
      mode,
    });
  },
};
