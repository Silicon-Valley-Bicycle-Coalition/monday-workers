import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './webhook/route';
import { D1PendingStore } from './db/pending';
import { D1DonationLinksStore } from './db/links';
import { HttpMondayClient } from './monday/client';
import { processRecomputeBatch } from './consumer/processBatch';
import type { Env, RecomputeQueueMessage } from './types';

const config = validateConfig(rawConfig);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = createApp({
      pendingStore: new D1PendingStore(env.DB),
      queue: {
        send: (message: RecomputeQueueMessage) => env.RECOMPUTE_QUEUE.send(message).then(() => undefined),
      },
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<RecomputeQueueMessage>, env: Env): Promise<void> {
    await processRecomputeBatch([...batch.messages], {
      pendingStore: new D1PendingStore(env.DB),
      linksStore: new D1DonationLinksStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
    });
  },
};
