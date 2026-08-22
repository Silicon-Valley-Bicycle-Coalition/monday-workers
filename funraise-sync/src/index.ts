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
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
      queue: {
        send: (message: { eventId: string }) => env.WRITE_QUEUE.send(message).then(() => undefined),
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
};
