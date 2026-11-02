import { configFor } from './config';
import { handleBatch } from './consumer';
import { environmentOf } from './environment';
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
    monday: new HttpNearbyMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
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
      // A write that exhausted its retries: log the ids only (no name, label or address) and drop
      // it. Confirming the search again re-queues any contact still missing from the board.
      for (const msg of batch.messages) {
        console.error(JSON.stringify({ worker: WORKER, deadLetter: true, boardId: msg.body.boardId, itemId: msg.body.contactId }));
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

  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    throw new Error('nearby-search scheduled geocode: not implemented');
  },
};
