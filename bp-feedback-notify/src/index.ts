import { Hono } from 'hono';
import { configFor, environmentOf, type EnvironmentBindings } from './environment';
import { CloudflareEmailSender } from './email/cloudflareEmail';
import { sandboxEmailBinding } from './email/sandboxBinding';
import { InvalidWebhookPayloadError, parseFeedbackWebhookPayload } from './webhook';
import { timingSafeEqual } from './timingSafeEqual';
import { checkRequestRateLimit } from './rateLimit';
import { writeSendStatus } from './sendStatus';
import { claimSend, releaseSend } from './sendGuard';
import { readFeedbackItem } from './feedbackItem';
import { tokenProviderFor, type MondayTokenSource, type TokenProvider } from './mondayApi';
import { redactEmails } from './redactEmails';
import { DEFAULT_PII_KEYS, logSkip, readLogLevel, readWriteMode, redactPayload } from './flags';
import production from '../config/production.json';
import sandbox from '../config/sandbox.json';

export interface Env extends EnvironmentBindings {
  EMAIL: SendEmail;
  WEBHOOK_SECRET: string;
  SANDBOX_EMAIL_SINK?: string;
  // Monday access — reads the organizer's address and event name off the item
  // (src/feedbackItem.ts), and writes the send status back when config.sendStatus is set
  // (src/sendStatus.ts). The monday-auth broker's SyncToken entrypoint (wrangler.jsonc services);
  // the fixed MONDAY_API_TOKEN secret is only the fallback while the OAuth cutover is under way.
  // tokenProviderFor (src/mondayApi.ts) prefers the binding.
  MONDAY_AUTH?: MondayTokenSource;
  MONDAY_API_TOKEN?: string;
  // Provisioned in wrangler.jsonc — see README "Reliability: traffic and cost limits".
  REQUEST_RATE_LIMITER: RateLimit;
  // Write-switch flags KV (src/flags.ts); a missing binding reads as mode `unknown`.
  FLAGS?: KVNamespace;
  // Per-item resend guard (src/sendGuard.ts, migrations/). Missing or failing, nothing is sent (503).
  DB?: D1Database;
}

const WORKER = 'bp-feedback-notify';

const app = new Hono<{ Bindings: Env }>();

// Checked before any routing or email-sending work — see README "Reliability: traffic and cost
// limits". Registered first so it gates every route below (Hono runs middleware in registration
// order).
app.use('*', async (c, next) => {
  const limited = await checkRequestRateLimit(c.req.raw, { limit: (key) => c.env.REQUEST_RATE_LIMITER.limit({ key }) });
  if (limited) return limited;
  await next();
});

// monday.com's "Send a webhook" automation action has no custom-header field in its UI — the
// connection URL itself is the only place to put a secret — so the shared secret is checked as
// a query param (?secret=...) as well as the X-Webhook-Secret header, for whichever caller sets
// it. A missing/mismatched secret is rejected before the body is even parsed.
//
// The query-param path means WEBHOOK_SECRET lands in this Worker's Cloudflare access logs
// (Logpush/`wrangler tail`) on every monday-triggered request — there's no way around that as
// long as monday's webhook action stays header-less. Treat those logs as holding a live secret:
// restrict who can read them, and rotate WEBHOOK_SECRET if that access ever widens.
function isAuthorized(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }, env: Env): boolean {
  if (!env.WEBHOOK_SECRET) return false;
  const provided = c.req.header('X-Webhook-Secret') ?? c.req.query('secret') ?? '';
  return timingSafeEqual(provided, env.WEBHOOK_SECRET);
}

app.post('/webhook/bp-feedback', async (c) => {
  if (!isAuthorized(c, c.env)) {
    return c.text('unauthorized', 401);
  }

  const body = await c.req.json().catch(() => null);

  // monday.com verifies a newly connected webhook URL by POSTing a one-off `{"challenge": "..."}`
  // body and expecting it echoed back — see the "Send a webhook" action's own tooltip. This must
  // be handled before payload validation, since a challenge body isn't a real feedback payload.
  if (body !== null && typeof body === 'object' && typeof (body as Record<string, unknown>).challenge === 'string') {
    return c.json({ challenge: (body as { challenge: string }).challenge });
  }

  let payload;
  try {
    payload = parseFeedbackWebhookPayload(body);
  } catch (error) {
    if (error instanceof InvalidWebhookPayloadError) {
      return c.text(`bad request: ${error.message}`, 400);
    }
    throw error;
  }

  // Challenge and auth are above; the write switch gates everything that sends. Read once.
  const mode = await readWriteMode(c.env, WORKER);
  if (mode === 'hold' || mode === 'unknown') {
    // Nothing is queued here, so a 503 is the only way to keep the request alive: monday retries.
    console.log(JSON.stringify({ event: 'bp-feedback-held', worker: WORKER, mode, itemId: payload.itemId }));
    return c.text('writes are held', 503);
  }
  if (mode === 'off') {
    const logLevel = await readLogLevel(c.env, WORKER);
    logSkip(
      { worker: WORKER, environment: environmentOf(c.env), mode, logLevel, deliveryId: String(payload.itemId), piiKeys: DEFAULT_PII_KEYS },
      'Feedback email',
      'sendFeedbackRequestEmail',
      redactPayload(payload, DEFAULT_PII_KEYS),
    );
    return c.json({ sent: false, skipped: true, itemId: payload.itemId });
  }

  const config = configFor(c.env, production, sandbox);
  const environment = c.env.ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
  const { itemId } = payload;
  // An empty MONDAY_API_TOKEN counts as unset, as it always has here.
  let token: TokenProvider;
  try {
    token = tokenProviderFor({ MONDAY_AUTH: c.env.MONDAY_AUTH, MONDAY_API_TOKEN: c.env.MONDAY_API_TOKEN || undefined });
  } catch {
    console.error(JSON.stringify({ event: 'bp-feedback-misconfigured', environment, itemId, reason: 'neither MONDAY_AUTH nor MONDAY_API_TOKEN is set' }));
    return c.json({ sent: false, itemId }, 500);
  }

  // The recipient and event name come from the board, never the request body (GL#66).
  let item;
  try {
    item = await readFeedbackItem(
      config.board,
      token,
      itemId,
      config.sendStatus && { columnId: config.sendStatus.columnId, sentLabel: config.sendStatus.sentLabel },
    );
  } catch (error) {
    // Transient or not, nothing was sent: a 502 lets monday retry.
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'bp-feedback-item-read-failed', environment, itemId, error: redactEmails(message, []) }));
    return c.json({ sent: false, itemId }, 502);
  }
  if (item.kind === 'not-found' || item.kind === 'wrong-board') {
    // Not an item on the configured board: send nothing and write nothing back to it.
    console.error(JSON.stringify({ event: 'bp-feedback-item-refused', environment, itemId, reason: item.kind }));
    return c.json({ sent: false, itemId }, 404);
  }
  if (item.kind === 'already-sent') {
    // A replayed or looped webhook must not email the organizer again (GL#105). 200, not an error,
    // so monday doesn't retry; staff re-send by moving the status back to Ready to Send.
    console.log(JSON.stringify({ event: 'bp-feedback-already-sent', environment, itemId }));
    return c.json({ sent: false, alreadySent: true, itemId });
  }
  if (item.kind === 'no-email') {
    console.error(JSON.stringify({ event: 'bp-feedback-no-email', environment, itemId }));
    c.executionCtx.waitUntil(writeSendStatus(config.sendStatus, token, itemId, 'failed'));
    return c.json({ sent: false, itemId }, 422);
  }

  // Per-item resend guard (GL#105): works whether or not sendStatus is configured. Fails closed — a
  // guard we can't check sends nothing, and the 503 lets monday retry.
  const claimedAt = Date.now();
  let claimed: boolean;
  try {
    if (!c.env.DB) throw new Error('DB binding is not set');
    claimed = await claimSend(c.env.DB, itemId, claimedAt, config.resendCooldownHours * 3_600_000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'bp-feedback-guard-failed', environment, itemId, error: redactEmails(message, [item.organizerEmail]) }));
    return c.json({ sent: false, itemId }, 503);
  }
  if (!claimed) {
    // Emailed within the cooldown: a replayed or looped webhook. 200 so monday doesn't retry.
    console.log(JSON.stringify({ event: 'bp-feedback-resend-cooldown', environment, itemId }));
    return c.json({ sent: false, alreadySent: true, itemId });
  }

  const binding =
    environment === 'sandbox'
      ? sandboxEmailBinding(c.env.EMAIL, requireSandboxSink(c.env))
      : c.env.EMAIL;

  const sender = new CloudflareEmailSender(binding, config.fromAddress, config.fromName, config.logoUrl);
  try {
    await sender.sendFeedbackRequestEmail({
      to: item.organizerEmail,
      eventName: item.eventName,
      feedbackFormUrl: config.feedbackFormUrl,
    });
  } catch (error) {
    // Staff only ever look at the board, so a failed send is logged (Workers observability) and,
    // when configured, written back onto the item — otherwise it is invisible to them.
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'bp-feedback-send-failed', environment, itemId, error: redactEmails(message, [item.organizerEmail]) }));
    // Nothing went out, so free the item for monday's retry. Must finish before the retry arrives.
    await releaseSend(c.env.DB!, itemId, claimedAt).catch((releaseError: unknown) => {
      const detail = releaseError instanceof Error ? releaseError.message : String(releaseError);
      console.error(JSON.stringify({ event: 'bp-feedback-guard-release-failed', environment, itemId, error: redactEmails(detail, [item.organizerEmail]) }));
    });
    c.executionCtx.waitUntil(writeSendStatus(config.sendStatus, token, itemId, 'failed'));
    return c.json({ sent: false, itemId }, 500);
  }

  console.log(JSON.stringify({ event: 'bp-feedback-sent', environment, itemId }));
  // Answer monday immediately and write the status back in the background: awaiting a slow
  // Monday API here could hold the webhook past monday's timeout, and a retried webhook would
  // email the organizer again.
  c.executionCtx.waitUntil(writeSendStatus(config.sendStatus, token, itemId, 'sent'));
  return c.json({ sent: true, itemId });
});

function requireSandboxSink(env: Env): string {
  if (!env.SANDBOX_EMAIL_SINK) {
    // Fail closed: without a sink, sandboxEmailBinding has nowhere safe to redirect to.
    throw new Error('SANDBOX_EMAIL_SINK must be set when ENVIRONMENT=sandbox');
  }
  return env.SANDBOX_EMAIL_SINK;
}

export default app;
