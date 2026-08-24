import rawConfig from '../config/sources.json';
import { validateConfig } from './config';
import { createApp } from './route';
import { D1EventStore } from './db/events';
import { syncAllSources } from './sync';
import { fetchSourceEvents } from './adapters/dispatch';
import type { Env } from './types';

const config = validateConfig(rawConfig);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const app = createApp({
      eventStore: new D1EventStore(env.DB),
      now: () => new Date(),
    });
    return app.fetch(request, env, ctx);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await syncAllSources({
      eventStore: new D1EventStore(env.DB),
      config,
      slackWebhookUrl: env.SLACK_WEBHOOK_URL,
      now: new Date(),
      fetchSourceEvents,
    });
  },
};
