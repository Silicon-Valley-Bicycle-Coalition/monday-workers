import rawConfig from '../config/svbc.json';
import { validateConfig } from './config';
import { createApp } from './routes';
import { D1MagicLinkTokenStore } from './db/tokens';
import { D1SessionStore } from './db/sessions';
import { D1LoginAttemptStore } from './db/loginAttempts';
import { HttpMondayClient } from './monday/client';
import { ResendEmailSender } from './email/resend';
import type { Env } from './types';

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
