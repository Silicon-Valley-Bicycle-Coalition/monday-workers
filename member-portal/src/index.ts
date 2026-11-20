import { environmentOf, queueBaseName } from './environment';
import { configFor } from './configFor';
import { sandboxEmailBinding } from './email/sandboxBinding';
import { pledgesEnabled } from './config';
import { createApp } from './routes';
import { D1MagicLinkTokenStore } from './db/tokens';
import { D1SessionStore } from './db/sessions';
import { D1VerifiedEmailStore } from './db/verifiedEmails';
import { D1CodeFailureStore } from './db/codeFailures';
import { D1LoginAttemptStore } from './db/loginAttempts';
import { D1ChangeRequestStore } from './db/changeRequests';
import { D1CardTokenStore } from './db/cardTokens';
import { HttpMondayClient, orgReadConfig } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { discountOrganizationsCache, withCachedDiscounts } from './monday/discountCache';
import { CloudflareEmailSender } from './email/cloudflareEmail';
import { purgeExpiredChangeRequests } from './changeRequests/purgeExpired';
import { D1LetterSendStore } from './db/letterSends';
import { D1OrgStatementSendStore, type OrgStatementSendStore } from './db/orgStatementSends';
import { consumeLetterSendBatch } from './letters/processLetterSendBatch';
import { runLetterCron } from './letters/runLetterCron';
import type { Env, LetterSendQueueMessage, Config } from './types';
import type { LetterSendStore } from './db/letterSends';
import type { MondayClient } from './monday/client';
import type { MagicLinkTokenStore } from './db/tokens';
import type { EmailSender } from './email/types';
import { purgeExpiredCardTokens } from './card/purgeExpiredTokens';
import { purgeExpiredAuthRows } from './auth/purgeExpiredAuth';
import { D1AuthRetentionStore } from './db/authRetention';
import { checkRequestRateLimit } from './requestRateLimit';
import { lazyGate, readGate, type BatchSkipContext } from './writeSwitch';
import { logSkip } from './flags';
import { withTestAccounts } from './testAccounts/testAccountClient';

// In the sandbox every email is redirected to the sink; in production the binding is used as
// is. Exported for tests. The platform-side guard (the binding's allowed_destination_addresses
// in wrangler.jsonc) holds even if this function were wrong.
export function emailBindingFor(env: Env): SendEmail {
  if (environmentOf(env) !== 'sandbox') return env.EMAIL;
  if (!env.SANDBOX_EMAIL_SINK) {
    throw new Error('SANDBOX_EMAIL_SINK var must be set when ENVIRONMENT is "sandbox" (see wrangler.jsonc env.sandbox.vars)');
  }
  return sandboxEmailBinding(env.EMAIL, env.SANDBOX_EMAIL_SINK);
}

export interface QueueRouterDeps {
  letterStore: LetterSendStore;
  orgStore: OrgStatementSendStore;
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  config: Config;
  now: () => Date;
  // The write switch, read once for the batch (src/writeSwitch.ts).
  gate: BatchSkipContext;
}

// Extracted from queue() below so the routing decision can be exercised directly in tests with
// faked-out deps, instead of only through the real entrypoint (which always runs validateConfig
// against the real, placeholder-laden config/svbc.json and would throw before any routing logic
// ran). The portal consumes only the letter-emails queue (person letters and, as `kind: 'org'`,
// organization statements — consumeLetterSendBatch tells them apart): change requests are written to Monday
// by member-portal-writer (src/writer.ts), so the portal holds no Monday write credential. A
// change-requests batch reaching here is a misconfiguration and throws like any unknown queue.
export async function routeQueueBatch(
  batch: MessageBatch<LetterSendQueueMessage>,
  deps: QueueRouterDeps
): Promise<void> {
  const queueName = queueBaseName(batch.queue);

  if (queueName === 'member-portal-letter-emails') {
    await consumeLetterSendBatch(
      [...batch.messages],
      {
        store: deps.letterStore,
        orgStore: deps.orgStore,
        monday: deps.monday,
        tokenStore: deps.tokenStore,
        emailSender: deps.emailSender,
        config: deps.config,
        now: deps.now,
      },
      deps.gate
    );
    return;
  }

  throw new Error(`member-portal queue: unrecognized queue "${batch.queue}"`);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Validated lazily and memoized per environment — see configFor above. Must keep throwing
    // synchronously (before any routing or rate-limit check) on a misconfigured deploy.
    const config = configFor(env);
    const { donorsBoardId, donationsBoardId, organizationsBoardId } = config.monday;
    if (donorsBoardId === null || donationsBoardId === null || organizationsBoardId === null) {
      throw new Error('config: monday board ids must be set before this Worker can serve requests');
    }

    // Checked before any routing, D1, or Monday work — see README "Reliability: traffic and
    // cost limits". This is coarser than (and in addition to) the login/change/verify-specific
    // limits already threaded through createApp below via ipLimiter. REQUEST_RATE_LIMITER is
    // provisioned in wrangler.jsonc.
    return checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }).then((limited) => {
      if (limited) return limited;

      // Sandbox only: test-account addresses sign in at once and read dummy personas
      // (src/testAccounts/). Keyed on the environment, not config, so production can't turn it on.
      const testAccounts = environmentOf(env) === 'sandbox';
      const realMonday = withCachedDiscounts(
        new HttpMondayClient(
          config.monday.apiUrl,
          tokenProviderFor(env),
          config.monday.columns,
          donorsBoardId,
          donationsBoardId,
          organizationsBoardId,
          config.donations,
          // pledgesEnabled guarantees boardId is non-null and every column id is real, so the
          // non-null assertion below can't fire on a placeholder config.
          pledgesEnabled(config) ? { boardId: config.pledges.boardId!, columns: config.pledges.columns } : null,
          // Stays null while unset — getVolunteerShiftsForDonor throws its own config error on a
          // null board id rather than querying a sentinel.
          config.monday.volunteersBoardId,
          undefined,
          orgReadConfig(config)
        ),
        discountOrganizationsCache,
        `${config.monday.apiUrl}#${organizationsBoardId}`
      );
      const now = () => new Date();

      const app = createApp({
        monday: testAccounts ? withTestAccounts(realMonday, now, config.changeRequests.employer?.currentStatusLabel) : realMonday,
        testAccounts,
        tokenStore: new D1MagicLinkTokenStore(env.DB),
        sessionStore: new D1SessionStore(env.DB),
        verifiedEmailStore: new D1VerifiedEmailStore(env.DB),
        codeFailureStore: new D1CodeFailureStore(env.DB),
        attemptStore: new D1LoginAttemptStore(env.DB),
        emailSender: new CloudflareEmailSender(
          emailBindingFor(env),
          config.email.fromAddress,
          config.email.fromName,
          config.email.logoUrl,
          config.email.replyTo
        ),
        ipLimiter: { limit: (key: string) => env.LOGIN_RATE_LIMITER.limit({ key }) },
        config,
        now,
        changeStore: new D1ChangeRequestStore(env.DB),
        changeQueue: { send: (message) => env.CHANGE_QUEUE.send(message).then(() => undefined) },
        letterSendStore: new D1LetterSendStore(env.DB),
        letterQueue: { send: (message) => env.LETTER_SEND_QUEUE.send(message).then(() => undefined) },
        letterWebhookSecret: env.LETTER_WEBHOOK_SECRET,
        cardTokenStore: new D1CardTokenStore(env.DB),
        writeGate: lazyGate(() => readGate(env)),
      });
      return app.fetch(request, env, ctx);
    });
  },

  async queue(batch: MessageBatch<LetterSendQueueMessage>, env: Env): Promise<void> {
    // Validated lazily and memoized per environment — see configFor above.
    const config = configFor(env);
    // No pledges config passed (7th arg defaults to null): the letter consumer reads no pledges, so
    // getPledgesForDonor throws on this client by design. If a future consumer needs pledges,
    // wire the config here the way fetch() does — don't debug the throw first.
    const monday = new HttpMondayClient(
      config.monday.apiUrl,
      tokenProviderFor(env),
      config.monday.columns,
      config.monday.donorsBoardId ?? 0,
      config.monday.donationsBoardId ?? 0,
      config.monday.organizationsBoardId ?? 0,
      config.donations,
      null,
      // Same treatment as pledges above: no queue consumer reads volunteer history, and
      // getVolunteerShiftsForDonor throws its own config error on a null board id.
      config.monday.volunteersBoardId,
      undefined,
      orgReadConfig(config)
    );

    await routeQueueBatch(batch, {
      letterStore: new D1LetterSendStore(env.DB),
      orgStore: new D1OrgStatementSendStore(env.DB),
      monday,
      tokenStore: new D1MagicLinkTokenStore(env.DB),
      emailSender: new CloudflareEmailSender(
        emailBindingFor(env),
        config.email.fromAddress,
        config.email.fromName,
        config.email.logoUrl,
        config.email.replyTo
      ),
      config,
      now: () => new Date(),
      gate: await readGate(env),
    });
  },

  // Retention purge: see purgeExpiredChangeRequests for why 'written' rows are deleted and
  // 'queued' rows are left alone; see purgeExpiredCardTokens for why revoked card_tokens rows
  // are deleted and active ones are left alone; see purgeExpiredAuthRows for the auth tables.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Validated lazily and memoized per environment — see configFor above.
    const config = configFor(env);
    const purgedChangeRequests = await purgeExpiredChangeRequests({
      store: new D1ChangeRequestStore(env.DB),
      retentionDays: config.changeRequests.retentionDays,
      now: () => new Date(),
    });
    if (purgedChangeRequests > 0) {
      console.log(
        `member-portal scheduled: purged ${purgedChangeRequests} written change_requests rows past the ${config.changeRequests.retentionDays}-day retention window`
      );
    }

    const purgedCardTokens = await purgeExpiredCardTokens({
      store: new D1CardTokenStore(env.DB),
      retentionDays: config.cardTokens.retentionDays,
      now: () => new Date(),
    });
    if (purgedCardTokens > 0) {
      console.log(
        `member-portal scheduled: purged ${purgedCardTokens} revoked card_tokens rows past the ${config.cardTokens.retentionDays}-day retention window`
      );
    }

    // Auth-table retention (issue GL#31): login_attempts past rateLimit.attemptRetentionHours,
    // sessions and magic-link tokens past their own expiry. Bounded per run and per-table
    // failure-isolated inside purgeExpiredAuthRows, so it can't block the letter cron below.
    const purgedAuth = await purgeExpiredAuthRows({
      store: new D1AuthRetentionStore(env.DB),
      attemptRetentionHours: config.rateLimit.attemptRetentionHours,
      now: () => new Date(),
    });
    if (Object.values(purgedAuth).some((n) => n !== null && n > 0)) {
      console.log(
        `member-portal scheduled: purged ${purgedAuth.loginAttempts ?? 'n/a'} login_attempts, ` +
          `${purgedAuth.sessions ?? 'n/a'} expired sessions, ${purgedAuth.magicLinkTokens ?? 'n/a'} expired magic_link_tokens rows, ${purgedAuth.codeFailures ?? 'n/a'} code_failures`
      );
    }

    // Automatic January letter emails — gated entirely inside runLetterCron (the write switch on,
    // letterCron config filled in, taxLetter signed off for people and organization access on for
    // organization reps, and the Letter Settings board's Auto-send checkbox + start date), so on
    // most days this is one cheap settings read and a no-op. The
    // purges above are operational and run whatever the switch says.
    const gate = await readGate(env);
    const cronResult = await runLetterCron({
      monday: new HttpMondayClient(
        config.monday.apiUrl,
        tokenProviderFor(env),
        config.monday.columns,
        config.monday.donorsBoardId ?? 0,
        config.monday.donationsBoardId ?? 0,
        config.monday.organizationsBoardId ?? 0,
        config.donations,
        null,
        config.monday.volunteersBoardId,
        undefined,
        orgReadConfig(config)
      ),
      letterStore: new D1LetterSendStore(env.DB),
      orgStore: new D1OrgStatementSendStore(env.DB),
      queue: { send: (message) => env.LETTER_SEND_QUEUE.send(message).then(() => undefined) },
      config,
      now: () => new Date(),
      mode: gate.mode,
    });
    if (cronResult.kind === 'skipped' && cronResult.reason === 'write-switch') {
      logSkip({ ...gate, deliveryId: 'letter-cron' }, 'LetterQueue', 'runLetterCron', undefined);
    }
    // 'skipped' is the everyday quiet path; 'error' already logged inside runLetterCron.
    if (cronResult.kind === 'ran') {
      console.log(
        `member-portal letter cron: year ${cronResult.year} — ${cronResult.eligible} eligible, ` +
          `${cronResult.alreadyHandled} already handled, ${cronResult.triggered} queued, ` +
          `${cronResult.failed} failed, ${cronResult.deferred} deferred to tomorrow's run`
      );
      const orgs = cronResult.orgs;
      if (orgs) {
        console.log(
          `member-portal letter cron: year ${cronResult.year} organization statements — ${orgs.eligibleReps} reps, ` +
            `${orgs.alreadyHandled} already handled, ${orgs.triggered} queued, ${orgs.failed} failed, ` +
            `${orgs.deferred} deferred to tomorrow's run`
        );
      }
    }
  },
};
