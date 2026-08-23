import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1EventStore } from './db/events';
import { HttpMondayClient } from './monday/client';
import { processFunraiseQueueBatch, type FunraiseQueueMessage } from './consumer/processBatch';
import type { Env } from './types';

const config = validateConfig(rawConfig);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = createApp({
      eventStore: new D1EventStore(env.DB),
      config,
      queue: {
        send: (message: FunraiseQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined),
      },
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<FunraiseQueueMessage>, env: Env): Promise<void> {
    await processFunraiseQueueBatch([...batch.messages], {
      eventStore: new D1EventStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
    });
  },

  // Daily PII retention pass: raw Funraise payloads are only kept for replay and
  // debugging, so they are emptied once the write has been in Monday long enough.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const cutoff = new Date(
      Date.now() - config.funraiseSync.rawPayloadRetentionDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const purged = await new D1EventStore(env.DB).purgeWrittenPayloads(cutoff);
    if (purged > 0) {
      console.log(`funraise-sync scheduled: purged raw_payload from ${purged} written events older than ${cutoff}`);
    }
  },
};
