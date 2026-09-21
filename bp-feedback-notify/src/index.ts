import { Hono } from 'hono';
import { configFor, type EnvironmentBindings } from './environment';
import { CloudflareEmailSender } from './email/cloudflareEmail';
import { sandboxEmailBinding } from './email/sandboxBinding';
import { InvalidWebhookPayloadError, parseFeedbackWebhookPayload } from './webhook';
import production from '../config/production.json';
import sandbox from '../config/sandbox.json';

export interface Env extends EnvironmentBindings {
  EMAIL: SendEmail;
  WEBHOOK_SECRET: string;
  SANDBOX_EMAIL_SINK?: string;
}

const app = new Hono<{ Bindings: Env }>();

// monday.com's "Send a webhook" automation action has no custom-header field in its UI — the
// connection URL itself is the only place to put a secret — so the shared secret is checked as
// a query param (?secret=...) as well as the X-Webhook-Secret header, for whichever caller sets
// it. A missing/mismatched secret is rejected before the body is even parsed.
function isAuthorized(c: { req: { header: (name: string) => string | undefined; query: (name: string) => string | undefined } }, env: Env): boolean {
  if (!env.WEBHOOK_SECRET) return false;
  const provided = c.req.header('X-Webhook-Secret') ?? c.req.query('secret');
  return provided === env.WEBHOOK_SECRET;
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

  const config = configFor(c.env, production, sandbox);
  const environment = c.env.ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
  const binding =
    environment === 'sandbox'
      ? sandboxEmailBinding(c.env.EMAIL, requireSandboxSink(c.env))
      : c.env.EMAIL;

  const sender = new CloudflareEmailSender(binding, config.fromAddress, config.fromName, config.logoUrl);
  await sender.sendFeedbackRequestEmail({
    to: payload.organizerEmail,
    eventName: payload.eventName,
    feedbackFormUrl: config.feedbackFormUrl,
  });

  return c.json({ sent: true, itemId: payload.itemId });
});

function requireSandboxSink(env: Env): string {
  if (!env.SANDBOX_EMAIL_SINK) {
    // Fail closed: without a sink, sandboxEmailBinding has nowhere safe to redirect to.
    throw new Error('SANDBOX_EMAIL_SINK must be set when ENVIRONMENT=sandbox');
  }
  return env.SANDBOX_EMAIL_SINK;
}

export default app;
