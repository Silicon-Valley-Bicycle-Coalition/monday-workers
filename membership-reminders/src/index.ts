import { Hono } from 'hono';
import configJson from '../config/svbc.json';
import { validateConfig } from './config';
import { MondayClient } from './monday';
import { createEmailSender } from './email';
import { runReminders } from './reminders';

export interface Env extends Cloudflare.Env {
  MONDAY_API_TOKEN: string;
  EMAIL: SendEmail;
}

const config = validateConfig(configJson);

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const monday = new MondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN);
    const sendEmail = createEmailSender(env.EMAIL, config.email.fromAddress, config.email.fromName);
    ctx.waitUntil(
      runReminders(config, { monday, sendEmail }).catch((err) => {
        console.error(`[membership-reminders] run failed: ${(err as Error).message}`);
      }),
    );
  },
};
