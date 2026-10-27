import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, environmentOf } from './environment';
import { DIGEST_KEYS, validateConfig, type DigestKey } from './config';
import { HttpMondayClient } from './monday/client';
import { sandboxEmailBinding } from './email/sandboxBinding';
import { checkRequestRateLimit } from './rateLimit';
import { secretsMatch } from './secret';
import { dueDigests, runDigest, type RunDeps } from './run';
import { localTime } from './schedule';

export interface Env {
  EMAIL: SendEmail;
  MONDAY_API_TOKEN: string;
  DIGESTS_SECRET?: string;
  REQUEST_RATE_LIMITER: RateLimit;
  ENVIRONMENT?: string;
  SANDBOX_EMAIL_SINK?: string;
}

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once per
// isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

function deps(env: Env): RunDeps {
  const config = configFor(env);
  let email = env.EMAIL;
  if (environmentOf(env) === 'sandbox') {
    // Fail closed: without a sink, sandboxEmailBinding has nowhere safe to redirect to.
    if (!env.SANDBOX_EMAIL_SINK) throw new Error('SANDBOX_EMAIL_SINK must be set when ENVIRONMENT=sandbox');
    email = sandboxEmailBinding(env.EMAIL, env.SANDBOX_EMAIL_SINK);
  }
  return { monday: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN), email, config };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export default {
  // POST /digests/run?key=<digest>[&date=YYYY-MM-DD] with `Authorization: Bearer <DIGESTS_SECRET>`
  // sends one digest now, even an empty one — to resend a missed Monday, or to check a digest by
  // hand. `date` computes the digest as of that Pacific date (its windows, not the data).
  async fetch(request: Request, env: Env): Promise<Response> {
    configFor(env);
    const limited = await checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) });
    if (limited) return limited;
    const url = new URL(request.url);
    if (url.pathname !== '/digests/run') return new Response('not found', { status: 404 });
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    const presented = request.headers.get('Authorization')?.replace(/^Bearer /, '');
    if (!(await secretsMatch(presented, env.DIGESTS_SECRET))) return new Response('unauthorized', { status: 401 });

    const key = url.searchParams.get('key') ?? '';
    if (!(DIGEST_KEYS as readonly string[]).includes(key)) {
      return Response.json({ error: `key must be one of ${DIGEST_KEYS.join(', ')}` }, { status: 400 });
    }
    const d = deps(env);
    const date = url.searchParams.get('date');
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    // 20:00 UTC is midday the same calendar day in Pacific.
    const now = localTime(date ? new Date(`${date}T20:00:00Z`) : new Date(), d.config.timeZone);
    try {
      return Response.json(await runDigest(d, key as DigestKey, now, { force: true }));
    } catch (err) {
      console.error(`digest ${key} (http): ${errorText(err)}`);
      return Response.json({ error: errorText(err) }, { status: 500 });
    }
  },

  // Hourly (wrangler.jsonc). Each digest runs on its own, so one failing doesn't stop the rest;
  // a failure is logged as an error for Workers Issues.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const d = deps(env);
    const now = localTime(new Date(controller.scheduledTime), d.config.timeZone);
    for (const key of dueDigests(d.config, now)) {
      try {
        const result = await runDigest(d, key, now);
        console.log(JSON.stringify(result));
      } catch (err) {
        console.error(`digest ${key} (cron): ${errorText(err)}`);
      }
    }
  },
};
