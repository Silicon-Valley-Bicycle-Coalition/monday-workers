import { Hono } from 'hono';
import configJson from '../config/svbc.json';
import { validateConfig } from './config';
import { HttpMondayClient } from './monday/client';
import { HttpMailchimpClient } from './mailchimp/client';
import { D1PendingOutboundStore } from './db/pendingOutbound';
import { createOutboundApp } from './webhook/outboundRoute';
import { processOutboundBatch } from './consumer/outbound';
import type { Env, OutboundSyncMessage } from './types';

const config = validateConfig(configJson);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = new Hono();
    app.get('/health', (c) => c.json({ ok: true }));
    app.route('/', createOutboundApp({
      pendingStore: new D1PendingOutboundStore(env.DB),
      queue: { send: (message: OutboundSyncMessage) => env.OUTBOUND_QUEUE.send(message).then(() => undefined) },
      webhookSecret: env.MONDAY_WEBHOOK_SECRET,
    }));
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<OutboundSyncMessage>, env: Env): Promise<void> {
    await processOutboundBatch([...batch.messages], {
      pendingStore: new D1PendingOutboundStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      mailchimpClient: new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId),
      config,
    });
  },
};
