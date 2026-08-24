import { Hono } from 'hono';
import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { processSyncQueueBatch } from './consumer/processBatch';
import { D1MapStore } from './db/map';
import { D1MondayEventStore } from './db/mondayEvents';
import { D1QbEventStore } from './db/qbEvents';
import { HttpMondayClient } from './monday/client';
import { createMondayWebhookApp } from './monday/webhook/route';
import { HttpQuickBooksClient } from './quickbooks/client';
import { D1TokenStore } from './quickbooks/tokenStore';
import { createQbWebhookApp, type QueueLike } from './quickbooks/webhook/route';
import type { Env, QueueMessage } from './types';

const config = validateConfig(rawConfig);

// env.SYNC_QUEUE is a Cloudflare Queue<QueueMessage>, whose send() resolves to a
// QueueSendResponse rather than void. Adapt it to the QueueLike interface shared by
// the webhook routes (Task 11/13), which only needs fire-and-forget enqueueing.
function toQueueLike(queue: Queue<QueueMessage>): QueueLike {
  return {
    async send(message: QueueMessage): Promise<void> {
      await queue.send(message);
    },
  };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const mapStore = new D1MapStore(env.DB);
    const mondayClient = new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN);
    const quickBooksClient = new HttpQuickBooksClient(new D1TokenStore(env.DB), env.QB_CLIENT_ID, env.QB_CLIENT_SECRET);
    const queue = toQueueLike(env.SYNC_QUEUE);

    const app = new Hono();
    app.route(
      '/',
      createQbWebhookApp({
        qbEventStore: new D1QbEventStore(env.DB),
        quickBooksClient,
        queue,
        verifierToken: env.QB_WEBHOOK_VERIFIER_TOKEN,
      })
    );
    app.route(
      '/',
      createMondayWebhookApp({
        mondayEventStore: new D1MondayEventStore(env.DB),
        mapStore,
        queue,
        config,
      })
    );

    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    await processSyncQueueBatch([...batch.messages], {
      qbEventStore: new D1QbEventStore(env.DB),
      mondayEventStore: new D1MondayEventStore(env.DB),
      mapStore: new D1MapStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      quickBooksClient: new HttpQuickBooksClient(new D1TokenStore(env.DB), env.QB_CLIENT_ID, env.QB_CLIENT_SECRET),
      config,
    });
  },
};
