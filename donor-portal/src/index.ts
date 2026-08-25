import rawConfig from '../config/svbc.json';
import { validateConfig, pledgesEnabled } from './config';
import { createApp } from './routes';
import { D1MagicLinkTokenStore } from './db/tokens';
import { D1SessionStore } from './db/sessions';
import { D1LoginAttemptStore } from './db/loginAttempts';
import { D1ChangeRequestStore } from './db/changeRequests';
import { D1CardTokenStore } from './db/cardTokens';
import { HttpMondayClient } from './monday/client';
import { CloudflareEmailSender } from './email/cloudflareEmail';
import { processChangeQueueBatch } from './changeRequests/processBatch';
import { purgeExpiredChangeRequests } from './changeRequests/purgeExpired';
import { D1LetterSendStore } from './db/letterSends';
import { processLetterSendBatch } from './letters/processLetterSendBatch';
import type { Env, ChangeQueueMessage, LetterSendQueueMessage, Config } from './types';
import type { ChangeRequestStore } from './db/changeRequests';
import type { LetterSendStore } from './db/letterSends';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { EmailSender } from './email/types';
import { purgeExpiredCardTokens } from './card/purgeExpiredTokens';

export interface QueueRouterDeps {
  changeStore: ChangeRequestStore;
  letterStore: LetterSendStore;
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  config: Config;
  now: () => Date;
}

// Extracted from queue() below so the routing decision — which of the two source queues
// (distinguished by batch.queue) hands off to which processor — can be exercised directly in
// tests with faked-out deps, instead of only through the real entrypoint (which always runs
// validateConfig against the real, placeholder-laden config/svbc.json and would throw before any
// routing logic ran).
export async function routeQueueBatch(
  batch: MessageBatch<ChangeQueueMessage> | MessageBatch<LetterSendQueueMessage>,
  deps: QueueRouterDeps
): Promise<void> {
  if (batch.queue === 'donor-portal-change-requests') {
    await processChangeQueueBatch([...(batch as MessageBatch<ChangeQueueMessage>).messages], {
      store: deps.changeStore,
      monday: deps.monday,
      config: deps.config,
    });
    return;
  }

  if (batch.queue === 'donor-portal-letter-emails') {
    await processLetterSendBatch([...(batch as MessageBatch<LetterSendQueueMessage>).messages], {
      store: deps.letterStore,
      monday: deps.monday,
      tokenStore: deps.tokenStore,
      emailSender: deps.emailSender,
      config: deps.config,
      now: deps.now,
    });
    return;
  }

  throw new Error(`donor-portal queue: unrecognized queue "${batch.queue}"`);
}

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
        config.monday.organizationsBoardId,
        // pledgesEnabled guarantees boardId is non-null and every column id is real, so the
        // non-null assertion below can't fire on a placeholder config.
        pledgesEnabled(config) ? { boardId: config.pledges.boardId!, columns: config.pledges.columns } : null,
        // Stays null while unset — getVolunteerShiftsForDonor throws its own config error on a
        // null board id rather than querying a sentinel.
        config.monday.volunteersBoardId
      ),
      tokenStore: new D1MagicLinkTokenStore(env.DB),
      sessionStore: new D1SessionStore(env.DB),
      attemptStore: new D1LoginAttemptStore(env.DB),
      emailSender: new CloudflareEmailSender(env.EMAIL, config.email.fromAddress, config.email.fromName),
      ipLimiter: { limit: (key: string) => env.LOGIN_RATE_LIMITER.limit({ key }) },
      config,
      now: () => new Date(),
      changeStore: new D1ChangeRequestStore(env.DB),
      changeQueue: { send: (message) => env.CHANGE_QUEUE.send(message).then(() => undefined) },
      letterSendStore: new D1LetterSendStore(env.DB),
      letterQueue: { send: (message) => env.LETTER_SEND_QUEUE.send(message).then(() => undefined) },
      letterWebhookSecret: env.LETTER_WEBHOOK_SECRET,
      cardTokenStore: new D1CardTokenStore(env.DB),
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<ChangeQueueMessage> | MessageBatch<LetterSendQueueMessage>, env: Env): Promise<void> {
    // Same lazy-validation rationale as fetch() above: config/svbc.json ships with placeholder
    // board/column ids until an operator fills them in, so validation can't happen at import time.
    const config = validateConfig(rawConfig);
    // No pledges config passed (7th arg defaults to null): no queue consumer reads pledges, so
    // getPledgesForDonor throws on this client by design. If a future consumer needs pledges,
    // wire the config here the way fetch() does — don't debug the throw first.
    const monday = new HttpMondayClient(
      config.monday.apiUrl,
      env.MONDAY_API_TOKEN,
      config.monday.columns,
      config.monday.donorsBoardId ?? 0,
      config.monday.donationsBoardId ?? 0,
      config.monday.organizationsBoardId ?? 0,
      null,
      // Same treatment as pledges above: no queue consumer reads volunteer history, and
      // getVolunteerShiftsForDonor throws its own config error on a null board id.
      config.monday.volunteersBoardId
    );

    await routeQueueBatch(batch, {
      changeStore: new D1ChangeRequestStore(env.DB),
      letterStore: new D1LetterSendStore(env.DB),
      monday,
      tokenStore: new D1MagicLinkTokenStore(env.DB),
      emailSender: new CloudflareEmailSender(env.EMAIL, config.email.fromAddress, config.email.fromName),
      config,
      now: () => new Date(),
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
