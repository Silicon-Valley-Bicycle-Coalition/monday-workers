import { Hono } from 'hono';
import configJson from '../config/svbc.json';
import { validateConfig } from './config';
import { MondayClient } from './monday';
import { sendReminderEmail } from './email';
import { runReminders } from './reminders';

export interface Env {
  MONDAY_API_TOKEN: string;
}

const config = validateConfig(configJson);

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const monday = new MondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN);
    ctx.waitUntil(
      runReminders(config, { monday, sendEmail: sendReminderEmail }).catch((err) => {
        console.error(`[membership-reminders] run failed: ${(err as Error).message}`);
      }),
    );
  },
};
