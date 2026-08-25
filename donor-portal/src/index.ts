import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './routes';
import { D1MagicLinkTokenStore } from './db/tokens';
import { D1SessionStore } from './db/sessions';
import { D1LoginAttemptStore } from './db/loginAttempts';
import { D1ChangeRequestStore } from './db/changeRequests';
import { HttpMondayClient } from './monday/client';
import { ResendEmailSender } from './email/resend';
import { processChangeQueueBatch } from './changeRequests/processBatch';
import { purgeExpiredChangeRequests } from './changeRequests/purgeExpired';
import { D1LetterSendStore } from './db/letterSends';
import { processLetterSendBatch } from './letters/processLetterSendBatch';
import type { Env, ChangeQueueMessage, LetterSendQueueMessage } from './types';

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Validated lazily, per request, rather than at module scope: config/svbc.json ships with
    // placeholder board ids and column ids until an operator fills in the real ones (see
    // validateConfig's placeholder check in ./config), so a throwing validation call can't sit at
    // import time without also breaking every test file the Workers test runtime loads this
    // module for. Deferring it here keeps the "fail loudly on bad config" behavior (any request
    // throws immediately) without that side effect at import.
    const config = validateConfig(rawConfig);
    if (config.monday.donorsBoardId === null || config.monday.donationsBoardId === null || config.monday.organizationsBoardId === null) {
      throw new Error('config: monday board ids must be set before this Worker can serve requests');
    }

    const app = createApp({
      monday: new HttpMondayClient(
        config.monday.apiUrl,
        env.MONDAY_API_TOKEN,
        config.monday.columns,
        config.monday.donorsBoardId,
        config.monday.donationsBoardId,
        config.monday.organizationsBoardId
      ),
      tokenStore: new D1MagicLinkTokenStore(env.DB),
      sessionStore: new D1SessionStore(env.DB),
      attemptStore: new D1LoginAttemptStore(env.DB),
      emailSender: new ResendEmailSender(env.RESEND_API_KEY, config.resend.fromAddress, config.resend.fromName),
      ipLimiter: { limit: (key: string) => env.LOGIN_RATE_LIMITER.limit({ key }) },
      config,
      now: () => new Date(),
      changeStore: new D1ChangeRequestStore(env.DB),
      changeQueue: { send: (message) => env.CHANGE_QUEUE.send(message).then(() => undefined) },
      letterSendStore: new D1LetterSendStore(env.DB),
      letterQueue: { send: (message) => env.LETTER_SEND_QUEUE.send(message).then(() => undefined) },
      letterWebhookSecret: env.LETTER_WEBHOOK_SECRET,
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<ChangeQueueMessage> | MessageBatch<LetterSendQueueMessage>, env: Env): Promise<void> {
    // Same lazy-validation rationale as fetch() above: config/svbc.json ships with placeholder
    // board/column ids until an operator fills them in, so validation can't happen at import time.
    const config = validateConfig(rawConfig);
    const monday = new HttpMondayClient(
      config.monday.apiUrl,
      env.MONDAY_API_TOKEN,
      config.monday.columns,
      config.monday.donorsBoardId ?? 0,
      config.monday.donationsBoardId ?? 0,
      config.monday.organizationsBoardId ?? 0
    );

    if (batch.queue === 'donor-portal-change-requests') {
      await processChangeQueueBatch([...(batch as MessageBatch<ChangeQueueMessage>).messages], {
        store: new D1ChangeRequestStore(env.DB),
        monday,
        config,
      });
      return;
    }

    if (batch.queue === 'donor-portal-letter-emails') {
      await processLetterSendBatch([...(batch as MessageBatch<LetterSendQueueMessage>).messages], {
        store: new D1LetterSendStore(env.DB),
        monday,
        tokenStore: new D1MagicLinkTokenStore(env.DB),
        emailSender: new ResendEmailSender(env.RESEND_API_KEY, config.resend.fromAddress, config.resend.fromName),
        config,
        now: () => new Date(),
      });
      return;
    }

    throw new Error(`donor-portal queue: unrecognized queue "${batch.queue}"`);
  },

  // Retention purge: see purgeExpiredChangeRequests for why 'written' rows are deleted and
  // 'queued' rows are left alone.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Same lazy-validation rationale as fetch()/queue() above.
    const config = validateConfig(rawConfig);
    const purged = await purgeExpiredChangeRequests({
      store: new D1ChangeRequestStore(env.DB),
      retentionDays: config.changeRequests.retentionDays,
      now: () => new Date(),
    });
    if (purged > 0) {
      console.log(`donor-portal scheduled: purged ${purged} written change_requests rows past the ${config.changeRequests.retentionDays}-day retention window`);
    }
  },
};
