import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './routes';
import { D1MagicLinkTokenStore } from './db/tokens';
import { D1SessionStore } from './db/sessions';
import { D1LoginAttemptStore } from './db/loginAttempts';
import { HttpMondayClient } from './monday/client';
import { ResendEmailSender } from './email/resend';
import type { Env } from './types';

const config = validateConfig(rawConfig);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
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
    });
    return app.fetch(request, env, ctx);
  },
};
