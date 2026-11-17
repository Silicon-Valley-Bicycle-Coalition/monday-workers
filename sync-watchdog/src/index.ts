import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { cloudflareApi } from './cloudflare';
import { validateConfig } from './config';
import { createConfigSelector, environmentOf } from './environment';
import { runWatchdog } from './run';
import type { Env } from './types';

// One config per environment, chosen from env.ENVIRONMENT and validated once per isolate.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const cfg = configFor(env);
    await runWatchdog({
      cfg,
      api: cloudflareApi(cfg.accountId, env.CLOUDFLARE_API_TOKEN),
      flags: env.FLAGS,
      state: env.STATE,
      slackWebhookUrl: env.SLACK_WEBHOOK_URL,
      now: new Date(controller.scheduledTime),
      environment: environmentOf(env),
    });
  },
} satisfies ExportedHandler<Env>;
