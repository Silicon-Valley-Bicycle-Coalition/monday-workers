// dtd-sync entrypoint: a cron-only Worker, gated by the fleet write switch (src/flags.ts).
//
//   15 * * * *  pull (DTD -> Monday), push (Monday -> DTD), pairing (Matching Donation <-> gift)
//   0 10 * * *  summary (Matching Gift Program board)
//
// Write mode `on` runs live, `off` is a dry run (reads everything, logs each write it would make),
// `hold`/unknown skips the run. Each job has its own try/catch: one failing job is logged by name
// and the run goes on, except that a DtdAuthError (a bad key) drops the other DTD job, since it
// would fail the same way.
import { configFor, type DtdSyncConfig } from './config';
import { environmentOf } from './environment';
import { DEFAULT_PII_KEYS, readLogLevel, readWriteMode, runDisposition, type SkipContext } from './flags';
import { DtdAuthError, DtdClient } from './dtd/client';
import { HttpDtdMondayClient, type DtdMondayClient } from './monday/client';
import { redactText } from './logSafe';
import { tokenProviderFor, type MondayTokenSource } from './monday/graphql';
import { runPull, type PullDeps } from './jobs/pull';
import { runPush, type PushDeps } from './jobs/push';
import { runPairing, type PairingDeps } from './jobs/pairing';
import { runSummary, type SummaryDeps } from './jobs/summary';
import { dryRunDb, dryRunDtd, dryRunMonday, type DryRunnableDtd } from './writeSwitch';

const WORKER = 'dtd-sync';
const MONDAY_API_URL = 'https://api.monday.com/v2';

export const HOURLY_CRON = '15 * * * *';
export const NIGHTLY_CRON = '0 10 * * *';

// The generated Env types MONDAY_AUTH as a bare Service; at runtime it is the broker's SyncToken
// entrypoint. DTD_PRIVATE_KEY is a secret, so wrangler types doesn't know it.
type DtdEnv = Omit<Env, 'MONDAY_AUTH'> & { MONDAY_AUTH?: MondayTokenSource; MONDAY_API_TOKEN?: string; DTD_PRIVATE_KEY?: string };

export interface Clients {
  /** Null when DTD_PRIVATE_KEY is not set. */
  dtd: DryRunnableDtd | null;
  monday: DtdMondayClient;
  db: D1Database;
}

export interface Jobs {
  pull: (deps: PullDeps, now: Date) => Promise<unknown>;
  push: (deps: PushDeps, now: Date) => Promise<unknown>;
  pairing: (deps: PairingDeps, now: Date) => Promise<unknown>;
  summary: (deps: SummaryDeps, now: Date) => Promise<unknown>;
}

const LIVE_JOBS: Jobs = { pull: runPull, push: runPush, pairing: runPairing, summary: runSummary };

// Log the message only (a stack could carry more), scrubbed: Monday errors can echo submitted values.
function logFailure(job: string, err: unknown): void {
  console.log(`dtd-sync: ${job} failed ${err instanceof Error ? redactText(err.message) : 'unknown error'}`);
}

/** Runs the jobs one cron owes. `mode` 'dry-run' swaps every write for a skip line. */
export async function runCron(
  cron: string,
  clients: Clients,
  config: DtdSyncConfig,
  mode: 'run' | 'dry-run',
  skip: SkipContext,
  now: Date,
  jobs: Jobs = LIVE_JOBS,
): Promise<void> {
  if (cron !== HOURLY_CRON && cron !== NIGHTLY_CRON) {
    console.log(`dtd-sync: no jobs for cron ${cron}`);
    return;
  }
  const dry = mode === 'dry-run';
  const monday = dry ? dryRunMonday(clients.monday, skip) : clients.monday;
  const db = dry ? dryRunDb(clients.db, skip) : clients.db;
  const dtd = clients.dtd === null ? null : dry ? dryRunDtd(clients.dtd, skip) : clients.dtd;

  if (cron === NIGHTLY_CRON) {
    try {
      await jobs.summary({ monday, db, config }, now);
    } catch (err) {
      logFailure('summary', err);
    }
    return;
  }

  let dtdUsable = dtd !== null;
  if (dtd === null) console.log('dtd-sync: DTD_PRIVATE_KEY is not set');
  if (dtd !== null) {
    try {
      await jobs.pull({ dtd, monday, db, config }, now);
    } catch (err) {
      logFailure('pull', err);
      if (err instanceof DtdAuthError) dtdUsable = false;
    }
  }
  if (dtd !== null && dtdUsable) {
    try {
      await jobs.push({ dtd, monday, db, config }, now);
    } catch (err) {
      logFailure('push', err);
    }
  }
  try {
    await jobs.pairing({ monday, db, config }, now);
  } catch (err) {
    logFailure('pairing', err);
  }
}

async function skipContext(env: Env, mode: SkipContext['mode']): Promise<SkipContext> {
  return {
    worker: WORKER,
    environment: environmentOf(env),
    mode,
    logLevel: await readLogLevel(env, WORKER),
    deliveryId: crypto.randomUUID(),
    piiKeys: DEFAULT_PII_KEYS,
  };
}

export default {
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const mode = await readWriteMode(env, WORKER);
    const disposition = runDisposition(mode);
    if (disposition === 'skip') return;

    const config = configFor(env);
    const bindings = env as unknown as DtdEnv;
    const key = bindings.DTD_PRIVATE_KEY;
    const clients: Clients = {
      dtd: key ? new DtdClient(config.dtd.apiBase, key, config.dtd.publicKey) : null,
      monday: new HttpDtdMondayClient(MONDAY_API_URL, tokenProviderFor(bindings), config),
      db: env.DB,
    };
    await runCron(controller.cron, clients, config, disposition, await skipContext(env, mode), new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
