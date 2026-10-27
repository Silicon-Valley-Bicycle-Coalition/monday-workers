import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { createConfigSelector, environmentOf } from './environment';
import { DIGEST_KEYS, validateConfig, type DigestKey } from './config';
import { HttpMondayClient } from './monday/client';
import { sandboxEmailBinding } from './email/sandboxBinding';
import { checkRequestRateLimit } from './rateLimit';
import { secretsMatch } from './secret';
import { dueDigests, runDigest, type RunDeps } from './run';
import { localTime, type LocalTime } from './schedule';
import { DEFAULT_PII_KEYS, readLogLevel, readWriteMode, runDisposition } from './flags';
import { runDepsFor, type BatchSkipContext } from './writeSwitch';

// This Worker's name in the FLAGS KV keys (`report-digests:writes`, `report-digests:log`) — the
// directory name, as scripts/flags.mjs expects.
const WORKER = 'report-digests';

export interface Env {
  EMAIL: SendEmail;
  MONDAY_API_TOKEN: string;
  DIGESTS_SECRET?: string;
  REQUEST_RATE_LIMITER: RateLimit;
  ENVIRONMENT?: string;
  SANDBOX_EMAIL_SINK?: string;
  // The write switch (scripts/flags.mjs): every send is gated on `report-digests:writes`.
  FLAGS?: KVNamespace;
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

// The mode and log level, read once per request or cron run (never cached per isolate, so a flip
// reaches the next run within the KV edge cache's 30 seconds).
async function skipContext(env: Env): Promise<BatchSkipContext> {
  const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
  return { worker: WORKER, environment: environmentOf(env), mode, logLevel, piiKeys: DEFAULT_PII_KEYS };
}

/**
 * One hour's digests under the write switch: `on` sends each due digest; `off` builds each one and
 * logs the would-be send as a skip line; `hold` or an unreadable switch skips the hour with one
 * line. There is no cursor and no catch-up — a skipped hour's digests are resent by hand with
 * POST /digests/run once the switch is back `on`. Each digest runs on its own, so one failing
 * doesn't stop the rest; a failure is logged as an error for Workers Issues.
 */
export async function runScheduledDigests(scheduledTime: Date, depsOf: () => RunDeps, gate: BatchSkipContext): Promise<void> {
  const disposition = runDisposition(gate.mode);
  if (disposition === 'skip') {
    console.warn(`report-digests scheduled: write mode is "${gate.mode}"; skipping this hour's digests, nothing sent`);
    return;
  }
  const d = depsOf();
  const now: LocalTime = localTime(scheduledTime, d.config.timeZone);
  for (const key of dueDigests(d.config, now)) {
    try {
      const run = runDepsFor(disposition, d, { ...gate, deliveryId: `digest:${key}:${scheduledTime.toISOString()}` });
      const result = await runDigest(run, key, now);
      console.log(JSON.stringify(disposition === 'run' ? result : { ...result, writeSwitch: 'dry-run' }));
    } catch (err) {
      console.error(`digest ${key} (cron): ${errorText(err)}`);
    }
  }
}

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
    const date = url.searchParams.get('date');
    if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
    // The write switch gates this route like the cron: `off` builds the digest and logs the
    // would-be send; `hold` or an unreadable switch sends nothing and says so.
    const gate = await skipContext(env);
    const disposition = runDisposition(gate.mode);
    if (disposition === 'skip') {
      return Response.json({ error: `write switch is "${gate.mode}"; nothing sent` }, { status: 503 });
    }
    const d = deps(env);
    // 20:00 UTC is midday the same calendar day in Pacific.
    const now = localTime(date ? new Date(`${date}T20:00:00Z`) : new Date(), d.config.timeZone);
    try {
      const run = runDepsFor(disposition, d, { ...gate, deliveryId: `digest:${key}:http` });
      const result = await runDigest(run, key as DigestKey, now, { force: true });
      return Response.json(disposition === 'run' ? result : { ...result, writeSwitch: 'dry-run' });
    } catch (err) {
      console.error(`digest ${key} (http): ${errorText(err)}`);
      return Response.json({ error: errorText(err) }, { status: 500 });
    }
  },

  // Hourly (wrangler.jsonc); see runScheduledDigests.
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await runScheduledDigests(new Date(controller.scheduledTime), () => deps(env), await skipContext(env));
  },
};
