import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './routes';
import { D1MagicLinkTokenStore } from './db/tokens';
import { D1SessionStore } from './db/sessions';
import { D1LoginAttemptStore } from './db/loginAttempts';
import { D1ChangeRequestStore } from './db/changeRequests';
import { D1CardTokenStore } from './db/cardTokens';
import { HttpMondayClient } from './monday/client';
import { ResendEmailSender } from './email/resend';
import { processChangeQueueBatch } from './changeRequests/processBatch';
import { purgeExpiredChangeRequests } from './changeRequests/purgeExpired';
import { purgeExpiredCardTokens } from './card/purgeExpiredTokens';
import type { Env, ChangeQueueMessage } from './types';

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
      cardTokenStore: new D1CardTokenStore(env.DB),
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<ChangeQueueMessage>, env: Env): Promise<void> {
    // Same lazy-validation rationale as fetch() above: config/svbc.json ships with placeholder
    // board/column ids until an operator fills them in, so validation can't happen at import time.
    const config = validateConfig(rawConfig);
    await processChangeQueueBatch([...batch.messages], {
      store: new D1ChangeRequestStore(env.DB),
      monday: new HttpMondayClient(
        config.monday.apiUrl,
        env.MONDAY_API_TOKEN,
        config.monday.columns,
        config.monday.donorsBoardId ?? 0,
        config.monday.donationsBoardId ?? 0,
        config.monday.organizationsBoardId ?? 0
      ),
      config,
    });
  },

  // Retention purge: see purgeExpiredChangeRequests for why 'written' rows are deleted and
  // 'queued' rows are left alone; see purgeExpiredCardTokens for why revoked card_tokens rows
  // are deleted and active ones are left alone.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Same lazy-validation rationale as fetch()/queue() above.
    const config = validateConfig(rawConfig);
    const purgedChangeRequests = await purgeExpiredChangeRequests({
      store: new D1ChangeRequestStore(env.DB),
      retentionDays: config.changeRequests.retentionDays,
      now: () => new Date(),
    });
    if (purgedChangeRequests > 0) {
      console.log(
        `donor-portal scheduled: purged ${purgedChangeRequests} written change_requests rows past the ${config.changeRequests.retentionDays}-day retention window`
      );
    }

    const purgedCardTokens = await purgeExpiredCardTokens({
      store: new D1CardTokenStore(env.DB),
      retentionDays: config.cardTokens.retentionDays,
      now: () => new Date(),
    });
    if (purgedCardTokens > 0) {
      console.log(
        `donor-portal scheduled: purged ${purgedCardTokens} revoked card_tokens rows past the ${config.cardTokens.retentionDays}-day retention window`
      );
    }
  },
};
