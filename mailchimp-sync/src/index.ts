import { Hono } from 'hono';
import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, queueBaseName } from './environment';
import { validateConfig } from './config';
import { HttpMondayClient } from './monday/client';
import { MondayGraphQL, tokenProviderFor } from './monday/graphql';
import { HttpMailchimpClient } from './mailchimp/client';
import { D1PendingOutboundStore } from './db/pendingOutbound';
import { D1PendingInboundStore } from './db/pendingInbound';
import { D1CampaignItemsStore } from './db/campaignItems';
import { D1DnsUnsubscribeLog } from './db/dnsUnsubscribes';
import { createOutboundApp } from './webhook/outboundRoute';
import { createInboundApp } from './webhook/inboundRoute';
import { consumeOutboundBatch } from './consumer/outbound';
import { consumeInboundBatch } from './consumer/inbound';
import { processInboundDeadLetters, processOutboundDeadLetters } from './consumer/deadLetters';
import { reconcileCampaigns } from './campaigns/reconcile';
import { runScheduledReconcile } from './campaigns/scheduled';
import { CONSENT_CRON, runConsentSync } from './consent/run';
import { runRenewalDue } from './renewalDue/run';
import { JOURNEY_LOG_CRON, runJourneyLog } from './journeyLog/run';
import { createJourneyLogMonday } from './journeyLog/monday';
import { listJourneyEmails, readAddress, readSendTime, readSentTo } from './journeyLog/mailchimp';
import { D1JourneySendStore } from './db/journeySends';
import { adminBaseUrl, createProfileLinksMonday, runProfileLinks } from './profileLinks/run';
import { createConsentMonday, readMailchimpStatuses } from './consent/sources';
import { isMondayOutage } from './monday/outage';
import { DEFAULT_PII_KEYS, readLogLevel, readWriteMode } from './flags';
import { environmentOf } from './environment';
import type { BatchSkipContext } from './writeSwitch';
import { checkRequestRateLimit, isVerifiedMondayWebhook } from './rateLimit';
import { sendAlert } from './alert';
import { redactEmails } from './logSafe';
import type { Env, OutboundSyncMessage, InboundSyncMessage } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts. In the sandbox, mailchimp.audienceId
// names the sandbox audience; the split test is what keeps that id off the production file.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

const DLQ_SUFFIX = '-dlq';
const WORKER = 'mailchimp-sync';

// The write switch's mode and log level, read once per queue batch or cron run (never cached per
// isolate, so a flip reaches the next one within the KV edge cache's 30 s). Email is already in
// the default PII keys.
async function skipContext(env: Env): Promise<BatchSkipContext> {
  const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
  return { worker: WORKER, environment: environmentOf(env), mode, logLevel, piiKeys: DEFAULT_PII_KEYS };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // configFor validates synchronously and must keep throwing synchronously (before any
    // routing or rate-limit check) on a misconfigured ENVIRONMENT — see index.test.ts.
    const config = configFor(env);

    // Checked before any routing, D1, or Monday/Mailchimp work — see README "Reliability:
    // traffic and cost limits". REQUEST_RATE_LIMITER is provisioned in wrangler.jsonc.
    // A Monday webhook delivery that already passed verification skips it: Monday's own bulk-edit
    // traffic must not be throttled.
    return isVerifiedMondayWebhook(request, env.MONDAY_WEBHOOK_SECRET).then((verified) => verified
      ? null
      : checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }),
    ).then((limited) => {
      if (limited) return limited;

      const app = new Hono();
      app.get('/health', (c) => c.json({ ok: true }));
      app.route('/', createOutboundApp({
        pendingStore: new D1PendingOutboundStore(env.DB),
        queue: { send: (message: OutboundSyncMessage) => env.OUTBOUND_QUEUE.send(message).then(() => undefined) },
        webhookSecret: env.MONDAY_WEBHOOK_SECRET,
        config,
        writeMode: () => readWriteMode(env, WORKER),
      }));
      app.route('/', createInboundApp({
        pendingStore: new D1PendingInboundStore(env.DB),
        queue: { send: (message: InboundSyncMessage) => env.INBOUND_QUEUE.send(message).then(() => undefined) },
        webhookSecret: env.MAILCHIMP_WEBHOOK_SECRET,
        writeMode: () => readWriteMode(env, WORKER),
      }));
      return app.fetch(request, env, ctx);
    });
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    const config = configFor(env);

    // Dead-letter queues are "<main queue>-dlq" in both environments
    // (mailchimp-sync-outbound-dlq, mailchimp-sync-outbound-sandbox-dlq). Their consumer only
    // marks D1 rows (GL#37) — it never calls Monday or Mailchimp.
    const isDeadLetterQueue = batch.queue.endsWith(DLQ_SUFFIX);
    const queueName = queueBaseName(isDeadLetterQueue ? batch.queue.slice(0, -DLQ_SUFFIX.length) : batch.queue);

    const alert = (text: string) => sendAlert(env.SLACK_WEBHOOK_URL, text);

    if (isDeadLetterQueue && queueName === 'mailchimp-sync-outbound') {
      await processOutboundDeadLetters(batch.messages as readonly Message<OutboundSyncMessage>[], { store: new D1PendingOutboundStore(env.DB), alert });
      return;
    }

    if (isDeadLetterQueue && queueName === 'mailchimp-sync-inbound') {
      await processInboundDeadLetters(batch.messages as readonly Message<InboundSyncMessage>[], { store: new D1PendingInboundStore(env.DB), alert });
      return;
    }

    const gate = await skipContext(env);
    const mondayClient = new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env));
    const mailchimpClient = new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId);

    if (!isDeadLetterQueue && queueName === 'mailchimp-sync-outbound') {
      await consumeOutboundBatch(batch.messages as readonly Message<OutboundSyncMessage>[], {
        pendingStore: new D1PendingOutboundStore(env.DB),
        mondayClient,
        mailchimpClient,
        config,
        dnsLog: new D1DnsUnsubscribeLog(env.DB),
      }, gate);
      return;
    }

    if (!isDeadLetterQueue && queueName === 'mailchimp-sync-inbound') {
      await consumeInboundBatch(batch.messages as readonly Message<InboundSyncMessage>[], {
        pendingStore: new D1PendingInboundStore(env.DB),
        mondayClient,
        mailchimpClient,
        campaignItemsStore: new D1CampaignItemsStore(env.DB),
        config,
      }, gate);
      return;
    }

    // A typo'd or renamed queue name should fail loudly rather than silently falling
    // through to the inbound consumer, which would misprocess messages it can't parse.
    throw new Error(`unknown queue: ${batch.queue}`);
  },

  // Awaited, not handed to ctx.waitUntil: the runtime gives an awaited scheduled() handler the
  // full 15 minutes, while waitUntil work is only promised 30 seconds after the handler returns.
  // A failed run is logged, not thrown, so Workers Issues shows the error line.
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const config = configFor(env);
    // Three crons (wrangler.jsonc): the hourly consent sync (with the Mailchimp Profile links),
    // the hourly Journey send log, and the daily one that keeps the renewal-due tag and runs the
    // Campaigns reconcile. Any other cron string, or none, runs the daily work, as the one cron
    // did before.
    if (event.cron === CONSENT_CRON) {
      const started = Date.now();
      // Same tuning as HttpMondayClient's: a few in-process retries; the next hour does the rest.
      const transport = new MondayGraphQL(config.monday.apiUrl, tokenProviderFor(env), { maxAttempts: 3, requestTimeoutMs: 20_000 });
      const request = <T>(query: string, variables: Record<string, unknown>) => transport.request<T>(query, variables);
      // One member read for both steps: consent statuses, and each member's web_id for the
      // Mailchimp Profile link. A failed read fails both, so neither plans on a partial audience.
      const webIds = new Map<string, number>();
      let memberRead: Promise<Map<string, string>> | undefined;
      const readStatuses = () => (memberRead ??= readMailchimpStatuses({
        fetchFn: fetch.bind(globalThis),
        apiBaseUrl: config.mailchimp.apiBaseUrl,
        apiKey: env.MAILCHIMP_API_KEY,
        audienceId: config.mailchimp.audienceId,
        webIds,
      }));
      try {
        const gate = await skipContext(env);
        await runConsentSync(gate, {
          config,
          monday: createConsentMonday(request, { isOutage: isMondayOutage }),
          readStatuses,
          alert: (text) => sendAlert(env.SLACK_WEBHOOK_URL, text),
        });
      } catch (err) {
        console.error(`mailchimp-sync consent: run failed: ${(err as Error).name}: ${redactEmails((err as Error).message)}`);
      }
      // After consent, with what is left of the cron's 15 minutes.
      try {
        await runProfileLinks(await skipContext(env), {
          settings: config.profileLinks,
          monday: createProfileLinksMonday(request),
          readWebIds: () => readStatuses().then(() => webIds),
          adminBaseUrl: adminBaseUrl(config.mailchimp.apiBaseUrl),
          isOutage: isMondayOutage,
          deadline: started + 13.5 * 60_000,
        });
      } catch (err) {
        console.error(`mailchimp-sync profile-links: run failed: ${(err as Error).name}: ${redactEmails((err as Error).message)}`);
      }
      return;
    }
    if (event.cron === JOURNEY_LOG_CRON) {
      try {
        const transport = new MondayGraphQL(config.monday.apiUrl, tokenProviderFor(env), { maxAttempts: 3, requestTimeoutMs: 20_000 });
        const read = { fetchFn: fetch.bind(globalThis), apiBaseUrl: config.mailchimp.apiBaseUrl, apiKey: env.MAILCHIMP_API_KEY, audienceId: config.mailchimp.audienceId };
        await runJourneyLog(await skipContext(env), {
          config,
          mailchimp: {
            listJourneyEmails: (ids) => listJourneyEmails(read, ids),
            readSentTo: (id) => readSentTo(read, id),
            readSendTime: (emailId, campaignId) => readSendTime(read, emailId, campaignId),
            readAddress: (emailId) => readAddress(read, emailId),
          },
          monday: createJourneyLogMonday((query, variables, options) => transport.request(query, variables, options)),
          store: new D1JourneySendStore(env.DB),
          isOutage: isMondayOutage,
          alert: (text) => sendAlert(env.SLACK_WEBHOOK_URL, text),
        });
      } catch (err) {
        console.error(`mailchimp-sync journey-log: run failed: ${(err as Error).name}: ${redactEmails((err as Error).message)}`);
      }
      return;
    }
    // The daily cron also keeps the renewal-due tag, first and on its own: a reconcile failure
    // must not cost a day of renewal reminders, or the other way round.
    try {
      await runRenewalDue(await skipContext(env), { config, fetchFn: fetch.bind(globalThis), apiKey: env.MAILCHIMP_API_KEY });
    } catch (err) {
      console.error(`mailchimp-sync renewal-due: run failed: ${(err as Error).name}: ${redactEmails((err as Error).message)}`);
    }
    try {
      const gate = await skipContext(env);
      await runScheduledReconcile(gate, {
        mailchimpClient: new HttpMailchimpClient(config.mailchimp.apiBaseUrl, env.MAILCHIMP_API_KEY, config.mailchimp.audienceId),
        mondayClient: new HttpMondayClient(config.monday.apiUrl, tokenProviderFor(env)),
        campaignItemsStore: new D1CampaignItemsStore(env.DB),
        config,
      }, reconcileCampaigns);
    } catch (err) {
      console.error(`mailchimp-sync reconcile: run failed: ${(err as Error).message}`);
    }
  },
};
