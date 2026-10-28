import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { validateConfig } from './config';
import { createConfigSelector, environmentOf, queueBaseName } from './environment';
import { DEFAULT_PII_KEYS, readLogLevel, readWriteMode } from './flags';
import type { BatchSkipContext } from './writeSwitch';
import { createApp } from './webhook/route';
import { D1UploadStore } from './db/uploads';
import { D1DisbursementStore } from './db/disbursements';
import { D1RowStore } from './db/rows';
import { D1AliasStore } from './db/aliases';
import { HttpMondayClient } from './monday/client';
import { consumeBenevityBatch, type BenevityQueueMessage } from './consumer/processBatch';
import { readReportText } from './consumer/ingestUpload';
import { processDeadLetters, sweepDeadLetteredRows } from './consumer/deadLetters';
import { checkRequestRateLimit } from './rateLimit';
import type { Env, BenevityImportConfig } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector<BenevityImportConfig>({
  production: productionConfig,
  sandbox: sandboxConfig,
  validate: validateConfig,
});

const WORKER = 'benevity-import';
const WRITE_QUEUE = 'benevity-import-writes';
const DLQ_SUFFIX = '-dlq';

// The mode and log level, read once per request / queue batch (never cached per isolate, so a
// flip reaches the next one within the KV edge cache's 30 seconds).
async function skipContext(env: Env): Promise<BatchSkipContext> {
  const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
  return { worker: WORKER, environment: environmentOf(env), mode, logLevel, piiKeys: DEFAULT_PII_KEYS };
}

async function fetchCsv(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`benevity report fetch: HTTP ${response.status}`);
  }
  // Capped at MAX_REPORT_LENGTH bytes while it streams, whatever Content-Length says (or omits).
  return readReportText(response);
}

function writeQueue(env: Env) {
  return {
    sendBatch: (messages: BenevityQueueMessage[]) =>
      env.WRITE_QUEUE.sendBatch(messages.map((body) => ({ body }))).then(() => undefined),
  };
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // configFor validates synchronously and must keep throwing synchronously (before any
    // routing or rate-limit check) on a misconfigured ENVIRONMENT — see index.test.ts.
    const config = configFor(env);

    // Checked before any routing, D1, or Monday work — see README "Reliability: traffic and
    // cost limits". REQUEST_RATE_LIMITER is provisioned in wrangler.jsonc.
    return checkRequestRateLimit(request, { limit: (key) => env.REQUEST_RATE_LIMITER.limit({ key }) }).then((limited) => {
      if (limited) return limited;

      const app = createApp({
        mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
        uploadStore: new D1UploadStore(env.DB),
        disbursementStore: new D1DisbursementStore(env.DB),
        rowStore: new D1RowStore(env.DB),
        config,
        gate: () => skipContext(env),
        queue: writeQueue(env),
        webhookSecret: env.BENEVITY_WEBHOOK_SECRET,
        now: () => new Date().toISOString(),
      });
      return app.fetch(request, env, ctx);
    });
  },

  async queue(batch: MessageBatch<BenevityQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);

    // The dead-letter queue is "<write queue>-dlq" in both environments
    // (benevity-import-writes-dlq, benevity-import-writes-sandbox-dlq) — see
    // src/consumer/deadLetters.ts (#60). Anything else is refused rather than guessed at.
    const isDeadLetterQueue = batch.queue.endsWith(DLQ_SUFFIX);
    const queueName = queueBaseName(isDeadLetterQueue ? batch.queue.slice(0, -DLQ_SUFFIX.length) : batch.queue);
    if (queueName !== WRITE_QUEUE) {
      throw new Error(`benevity-import: no consumer for queue "${batch.queue}"`);
    }
    if (isDeadLetterQueue) {
      await processDeadLetters([...batch.messages], {
        rowStore: new D1RowStore(env.DB),
        uploadStore: new D1UploadStore(env.DB),
        mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
        config,
        writesOn: (await readWriteMode(env, WORKER)) === 'on',
      });
      return;
    }

    const gate = await skipContext(env);
    await consumeBenevityBatch([...batch.messages], {
      uploadStore: new D1UploadStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      aliasStore: new D1AliasStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
      queue: writeQueue(env),
      fetchCsv,
      now: () => new Date().toISOString(),
    }, gate);
  },

  // Daily PII retention pass (D1 only, no Monday write, so the write switch does not gate it): raw Benevity rows are kept only for replay/debugging, so they're
  // emptied once the write has been in Monday long enough (or, for rows that never resolved,
  // after the longer unresolved-row window). Same shape as funraise-sync's scheduled handler.
  // Then, while writes are `on`, the dead-letter sweep (#60) — which is a Monday write.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const config = configFor(env);
    const dayMs = 24 * 60 * 60 * 1000;
    const store = new D1RowStore(env.DB);
    const writtenCutoff = new Date(Date.now() - config.benevityImport.rawRowRetentionDays * dayMs).toISOString();
    const unresolvedCutoff = new Date(
      Date.now() - config.benevityImport.unresolvedRowRetentionDays * dayMs
    ).toISOString();
    const purgedWritten = await store.purgeWrittenRawRows(writtenCutoff);
    const purgedUnresolved = await store.purgeUnresolvedRawRows(unresolvedCutoff);
    if (purgedWritten > 0 || purgedUnresolved > 0) {
      console.log(
        `benevity-import scheduled: purged raw_row from ${purgedWritten} written (older than ${writtenCutoff}) and ${purgedUnresolved} unresolved (older than ${unresolvedCutoff}) rows`
      );
    }

    if ((await readWriteMode(env, WORKER)) !== 'on') return;
    const swept = await sweepDeadLetteredRows({
      rowStore: store,
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
    });
    if (swept.posted.length > 0 || swept.failed.length > 0) {
      console.log(
        `benevity-import scheduled: posted worklist items for ${swept.posted.length} dead-lettered row(s)` +
          (swept.failed.length > 0 ? `; ${swept.failed.length} failed and wait for tomorrow (${swept.failed.join(', ')})` : '')
      );
    }
  },
};
