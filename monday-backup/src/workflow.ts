import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { runSnapshot, type SnapshotStep } from './backup';
import { D1SnapshotRunStore } from './db/runs';
import { Deadline } from './deadline';
import { GoogleDriveClient } from './drive/client';
import { environmentOf } from './environment';
import type { Env } from './env';
import { DEFAULT_PII_KEYS, logSkip, readLogLevel, readWriteMode, runDisposition, type SkipContext } from './flags';
import { HttpMondayClient } from './monday/client';
import { MondayApiError, tokenProviderFor } from './monday/graphql';
import { RequestStats } from './monday/requestStats';
import { configFor } from './runConfig';
import { errorMessage } from './util/errorMessage';

const MONDAY_API_URL = 'https://api.monday.com/v2';
const WORKER = 'monday-backup';

// The transport has already retried transient failures by the time a step fails, so these mostly
// cover a bad minute: a step that fails three times is recorded and the run moves on.
const STEP_CONFIG = {
  retries: { limit: 2, delay: '1 minute', backoff: 'exponential' },
  timeout: '30 minutes',
} as const;

// Monday's daily limit resets at midnight UTC, so no retry within a run can clear it. Failing at once
// means each remaining board is recorded quickly, instead of a night of backoff.
export function isUnretryable(err: unknown): boolean {
  return err instanceof MondayApiError && /daily_limit/i.test(err.code ?? '');
}

export function asSnapshotStep(step: WorkflowStep): SnapshotStep {
  return {
    do: <T>(name: string, fn: () => Promise<T>) =>
      step.do(name, STEP_CONFIG, async () => {
        try {
          return (await fn()) as never;
        } catch (err) {
          if (isUnretryable(err)) throw new NonRetryableError(errorMessage(err));
          throw err;
        }
      }) as Promise<T>,
  };
}

// The nightly snapshot, one step per board or doc (src/backup.ts). Started by the cron in src/index.ts,
// or by hand: npx wrangler workflows trigger svbc-monday-backup-snapshot
export class SnapshotWorkflow extends WorkflowEntrypoint<Env, unknown> {
  override async run(_event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    const env = this.env;
    // One deadline shared by both clients; runSnapshot resets it for each step (src/deadline.ts).
    const deadline = new Deadline();
    const requestStats = new RequestStats();
    await runSnapshot(asSnapshotStep(step), {
      monday: new HttpMondayClient(MONDAY_API_URL, tokenProviderFor(env), { deadline, fetchFn: requestStats.fetchFn }),
      drive: new GoogleDriveClient(
        { clientEmail: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, privateKeyPem: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY },
        { deadline },
      ),
      deadline,
      requestStats,
      runStore: new D1SnapshotRunStore(env.DB),
      config: configFor(env),
      slackWebhookUrl: env.SLACK_WEBHOOK_URL,
      now: () => new Date(),
      // Read at each step rather than once, because a run lasts an hour and `hold` has to take effect.
      writesOn: async () => {
        const mode = await readWriteMode(env, WORKER);
        if (runDisposition(mode) === 'run') return true;
        const ctx: SkipContext = {
          worker: WORKER,
          environment: environmentOf(env),
          mode,
          logLevel: await readLogLevel(env, WORKER),
          deliveryId: 'snapshot-workflow',
          piiKeys: DEFAULT_PII_KEYS,
        };
        logSkip(ctx, 'Google Drive', 'runSnapshot', undefined);
        return false;
      },
    });
  }
}
