import { Hono } from 'hono';
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, queueBaseName } from './environment';
import { validateConfig } from './config';
import { HttpMondayClient } from './monday/client';
import { HttpMailchimpClient } from './mailchimp/client';
import { D1PendingOutboundStore } from './db/pendingOutbound';
import { D1PendingInboundStore } from './db/pendingInbound';
import { D1CampaignItemsStore } from './db/campaignItems';
import { createOutboundApp } from './webhook/outboundRoute';
import { createInboundApp } from './webhook/inboundRoute';
import { processOutboundBatch } from './consumer/outbound';
import { processInboundBatch } from './consumer/inbound';
import { reconcileCampaigns } from './campaigns/reconcile';
import type { Env, OutboundSyncMessage, InboundSyncMessage } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts. In the sandbox, mailchimp.audienceId
// names the sandbox audience; the split test is what keeps that id off the production file.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const config = configFor(env);
    const app = new Hono();
    app.get('/health', (c) => c.json({ ok: true }));
    app.route('/', createOutboundApp({
      pendingStore: new D1PendingOutboundStore(env.DB),
      queue: { send: (message: OutboundSyncMessage) => env.OUTBOUND_QUEUE.send(message).then(() => undefined) },
      webhookSecret: env.MONDAY_WEBHOOK_SECRET,
      config,
    }));
    app.route('/', createInboundApp({
      pendingStore: new D1PendingInboundStore(env.DB),
      queue: { send: (message: InboundSyncMessage) => env.INBOUND_QUEUE.send(message).then(() => undefined) },
      webhookSecret: env.MAILCHIMP_WEBHOOK_SECRET,
    }));
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const config = configFor(env);
    const mondayClient = new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN);
    const mailchimpClient = new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId);

    const queueName = queueBaseName(batch.queue);

    if (queueName === 'mailchimp-sync-outbound') {
      await processOutboundBatch(batch.messages as unknown as { body: OutboundSyncMessage; ack(): void; retry(): void }[], {
        pendingStore: new D1PendingOutboundStore(env.DB),
        mondayClient,
        mailchimpClient,
        config,
      });
      return;
    }

    if (queueName === 'mailchimp-sync-inbound') {
      await processInboundBatch(batch.messages as unknown as { body: InboundSyncMessage; ack(): void; retry(): void }[], {
        pendingStore: new D1PendingInboundStore(env.DB),
        mondayClient,
        mailchimpClient,
        campaignItemsStore: new D1CampaignItemsStore(env.DB),
        config,
      });
      return;
    }

    // A typo'd or renamed queue name should fail loudly rather than silently falling
    // through to the inbound consumer, which would misprocess messages it can't parse.
    throw new Error(`unknown queue: ${batch.queue}`);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const config = configFor(env);
    ctx.waitUntil(
      reconcileCampaigns({
        mailchimpClient: new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId),
        mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
        campaignItemsStore: new D1CampaignItemsStore(env.DB),
        config,
      })
        .then((result) => console.log(`mailchimp-sync reconcile: created ${result.created}, renamed ${result.renamed}, archived ${result.archived}`))
        .catch((err) => console.error(`mailchimp-sync reconcile: run failed: ${(err as Error).message}`)),
    );
  },
};
