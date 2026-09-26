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
import { D1DnsUnsubscribeLog } from './db/dnsUnsubscribes';
import { createOutboundApp } from './webhook/outboundRoute';
import { createInboundApp } from './webhook/inboundRoute';
import { processOutboundBatch } from './consumer/outbound';
import { processInboundBatch } from './consumer/inbound';
import { processInboundDeadLetters, processOutboundDeadLetters } from './consumer/deadLetters';
import { reconcileCampaigns } from './campaigns/reconcile';
import { checkRequestRateLimit } from './rateLimit';
import type { Env, OutboundSyncMessage, InboundSyncMessage } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts. In the sandbox, mailchimp.audienceId
// names the sandbox audience; the split test is what keeps that id off the production file.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

const DLQ_SUFFIX = '-dlq';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // configFor validates synchronously and must keep throwing synchronously (before any
    // routing or rate-limit check) on a misconfigured ENVIRONMENT — see index.test.ts.
    const config = configFor(env);

    // Checked before any routing, D1, or Monday/Mailchimp work — see README "Reliability:
    // traffic and cost limits". REQUEST_RATE_LIMITER is provisioned in wrangler.jsonc.
    return checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }).then((limited) => {
      if (limited) return limited;

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
    });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const config = configFor(env);

    // Dead-letter queues are "<main queue>-dlq" in both environments
    // (mailchimp-sync-outbound-dlq, mailchimp-sync-outbound-sandbox-dlq). Their consumer only
    // marks D1 rows (#37) — it never calls Monday or Mailchimp.
    const isDeadLetterQueue = batch.queue.endsWith(DLQ_SUFFIX);
    const queueName = queueBaseName(isDeadLetterQueue ? batch.queue.slice(0, -DLQ_SUFFIX.length) : batch.queue);

    if (isDeadLetterQueue && queueName === 'mailchimp-sync-outbound') {
      await processOutboundDeadLetters(batch.messages as readonly Message<OutboundSyncMessage>[], { store: new D1PendingOutboundStore(env.DB) });
      return;
    }

    if (isDeadLetterQueue && queueName === 'mailchimp-sync-inbound') {
      await processInboundDeadLetters(batch.messages as readonly Message<InboundSyncMessage>[], { store: new D1PendingInboundStore(env.DB) });
      return;
    }

    const mondayClient = new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN);
    const mailchimpClient = new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId);

    if (!isDeadLetterQueue && queueName === 'mailchimp-sync-outbound') {
      await processOutboundBatch(batch.messages as readonly Message<OutboundSyncMessage>[], {
        pendingStore: new D1PendingOutboundStore(env.DB),
        mondayClient,
        mailchimpClient,
        config,
        dnsLog: new D1DnsUnsubscribeLog(env.DB),
      });
      return;
    }

    if (!isDeadLetterQueue && queueName === 'mailchimp-sync-inbound') {
      await processInboundBatch(batch.messages as readonly Message<InboundSyncMessage>[], {
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
