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

// monday.com's "Send a webhook" automation action is configured with this header carrying a
// shared secret (see README "Monday automation setup") — the only auth this endpoint has, so a
// missing/mismatched header is rejected before the body is even parsed.
app.post('/webhook/bp-feedback', async (c) => {
  const provided = c.req.header('X-Webhook-Secret');
  if (!c.env.WEBHOOK_SECRET || provided !== c.env.WEBHOOK_SECRET) {
    return c.text('unauthorized', 401);
  }

  let payload;
  try {
    payload = parseFeedbackWebhookPayload(await c.req.json().catch(() => null));
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

  const sender = new CloudflareEmailSender(binding, config.fromAddress, config.fromName);
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
