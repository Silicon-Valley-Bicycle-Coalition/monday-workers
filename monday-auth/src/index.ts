import { WorkerEntrypoint } from 'cloudflare:workers';
import { slackAlert } from './alert';
import type { AppKey } from './apps';
import { TokenBroker } from './broker';
import type { Env } from './env';
import { createApp } from './routes';
import { D1AppTokenStore } from './tokenStore';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// One place that wires the broker to real I/O, so tests can spy on it or on TokenBroker.prototype.
export function brokerFor(env: Env): TokenBroker {
  return new TokenBroker({
    store: new D1AppTokenStore(env.DB),
    env,
    fetchFn: fetch,
    now: () => new Date(),
    sleep,
    alert: slackAlert(env.SLACK_WEBHOOK_URL, fetch),
  });
}

// Service-binding RPC surface: each class can only obtain its own app's token, so a consumer's
// binding decides which Monday app (and scopes) it can reach.
class AppToken extends WorkerEntrypoint<Env> {
  protected appKey: AppKey = 'portal';
  async token(rejected?: string): Promise<string> {
    return brokerFor(this.env).token(this.appKey, rejected);
  }
}

export class PortalToken extends AppToken {
  protected override appKey: AppKey = 'portal';
}
export class SyncToken extends AppToken {
  protected override appKey: AppKey = 'sync';
}
export class ReadOnlyToken extends AppToken {
  protected override appKey: AppKey = 'readonly';
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const app = createApp({
      store: new D1AppTokenStore(env.DB),
      env,
      fetchFn: fetch,
      now: () => new Date(),
      broker: brokerFor(env),
    });
    return app.fetch(request, env);
  },

  // Refresh tokens that are near expiry and drop abandoned consent rows. Independent: one
  // failing must not skip the other.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await brokerFor(env).refreshAllIfDue();
    } catch (err) {
      console.error(`monday-auth: scheduled refresh failed: ${err instanceof Error ? err.message : 'error'}`);
    }
    try {
      await new D1AppTokenStore(env.DB).purgeExpiredPending(new Date());
    } catch (err) {
      console.error(`monday-auth: purging abandoned consent rows failed: ${err instanceof Error ? err.message : 'error'}`);
    }
  },
};
