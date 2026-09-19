import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { validateConfig } from './config';
import { createConfigSelector } from './environment';
import { createApp } from './webhook/route';
import { D1UploadStore } from './db/uploads';
import { D1DisbursementStore } from './db/disbursements';
import { D1RowStore } from './db/rows';
import { D1AliasStore } from './db/aliases';
import { HttpMondayClient } from './monday/client';
import { processBenevityQueueBatch, type BenevityQueueMessage } from './consumer/processBatch';
import type { Env, BenevityImportConfig } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts and config/split.test.ts.
const configFor = createConfigSelector<BenevityImportConfig>({
  production: productionConfig,
  sandbox: sandboxConfig,
  validate: validateConfig,
});

async function fetchCsv(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`benevity report fetch: HTTP ${response.status}`);
  }
  return response.text();
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const config = configFor(env);
    const app = createApp({
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      uploadStore: new D1UploadStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      rowStore: new D1RowStore(env.DB),
      config,
      queue: {
        send: (message: BenevityQueueMessage) => env.WRITE_QUEUE.send(message).then(() => undefined),
      },
      webhookSecret: env.BENEVITY_WEBHOOK_SECRET,
      fetchCsv,
      now: () => new Date().toISOString(),
    });
    return app.fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<BenevityQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    await processBenevityQueueBatch([...batch.messages], {
      rowStore: new D1RowStore(env.DB),
      disbursementStore: new D1DisbursementStore(env.DB),
      aliasStore: new D1AliasStore(env.DB),
      mondayClient: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      config,
      now: () => new Date().toISOString(),
    });
  },

  // Daily PII retention pass: raw Benevity rows are kept only for replay/debugging, so they're
  // emptied once the write has been in Monday long enough (or, for rows that never resolved,
  // after the longer unresolved-row window). Same shape as funraise-sync's scheduled handler.
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
  },
};
