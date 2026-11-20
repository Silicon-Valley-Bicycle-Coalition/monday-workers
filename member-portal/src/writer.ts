import { queueBaseName } from './environment';
import { configFor } from './configFor';
import { D1ChangeRequestStore } from './db/changeRequests';
import { HttpMondayClient, orgReadConfig } from './monday/client';
import { tokenProviderFor } from './monday/graphql';
import { consumeChangeQueueBatch } from './changeRequests/processBatch';
import { readGate } from './writeSwitch';
import type { Env, ChangeQueueMessage } from './types';

// member-portal-writer: the only Worker that writes the portal's change requests to Monday. The
// portal (src/index.ts) is read-only — its MONDAY_AUTH binding is the broker's PortalToken — and
// enqueues to member-portal-change-requests; this Worker consumes that queue with the broker's
// SyncToken. It shares the portal's D1 database, FLAGS namespace (and so its write switch, keyed
// on the `member-portal` worker name) and config. No fetch or scheduled handler: nothing routes
// to it. Config: wrangler.writer.jsonc (`npm run deploy:writer`).
export default {
  async queue(batch: MessageBatch<ChangeQueueMessage>, env: Env): Promise<void> {
    // Checked before any config, D1 or Monday work: this Worker is bound to exactly one queue.
    if (queueBaseName(batch.queue) !== 'member-portal-change-requests') {
      throw new Error(`member-portal-writer queue: unrecognized queue "${batch.queue}"`);
    }
    const config = configFor(env);
    // Same client construction as the portal's queue(): no consumer here reads pledges, and
    // board ids are only used by reads this Worker never makes.
    const monday = new HttpMondayClient(
      config.monday.apiUrl,
      tokenProviderFor(env),
      config.monday.columns,
      config.monday.donorsBoardId ?? 0,
      config.monday.donationsBoardId ?? 0,
      config.monday.organizationsBoardId ?? 0,
      config.donations,
      null,
      config.monday.volunteersBoardId,
      undefined,
      orgReadConfig(config)
    );

    await consumeChangeQueueBatch(
      [...batch.messages],
      { store: new D1ChangeRequestStore(env.DB), monday, config, emailPreferences: env.MAILCHIMP_PREFS },
      await readGate(env)
    );
  },
};
