// Retention deletes for the three auth tables (issue GL#31) — used only by the daily scheduled()
// purge, so it's its own store rather than widening the request-path stores' interfaces.
export interface AuthRetentionStore {
  // login_attempts holds a hashed address per login email allowed (valid donor or not) — only
  // needed inside the per-address rate-limit look-back (24 hours, the daily cap).
  purgeLoginAttemptsBefore(cutoffISO: string): Promise<number>;
  purgeSessionsExpiredBefore(nowISO: string): Promise<number>;
  // Expired tokens only, used or not. A used-but-unexpired token is already inert (used_at set),
  // and deleting it early could race consumeToken's UPDATE-then-SELECT.
  purgeMagicLinkTokensExpiredBefore(nowISO: string): Promise<number>;
}

export interface BatchOptions {
  batchSize: number;
  maxBatches: number;
}

// At most 10,000 rows per table per daily run. The first run after deploy may face months of
// login_attempts; bounding it keeps one cron invocation's D1 time predictable, and the next run
// continues where this one stopped.
const DEFAULT_BATCH: BatchOptions = { batchSize: 500, maxBatches: 20 };

export class D1AuthRetentionStore implements AuthRetentionStore {
  constructor(
    private db: D1Database,
    private batch: BatchOptions = DEFAULT_BATCH
  ) {}

  purgeLoginAttemptsBefore(cutoffISO: string): Promise<number> {
    return this.deleteInBatches('login_attempts', 'attempted_at', cutoffISO);
  }

  purgeSessionsExpiredBefore(nowISO: string): Promise<number> {
    return this.deleteInBatches('sessions', 'expires_at', nowISO);
  }

  purgeMagicLinkTokensExpiredBefore(nowISO: string): Promise<number> {
    return this.deleteInBatches('magic_link_tokens', 'expires_at', nowISO);
  }

  // DELETE ... LIMIT needs SQLITE_ENABLE_UPDATE_DELETE_LIMIT, which D1 doesn't promise — so each
  // batch deletes by rowid from a LIMITed subquery instead. Table/column names are fixed literals
  // from the methods above, never input. Each column is indexed (migrations/0005).
  private async deleteInBatches(table: string, column: string, cutoffISO: string): Promise<number> {
    let total = 0;
    for (let i = 0; i < this.batch.maxBatches; i++) {
      const result = await this.db
        .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} < ?1 LIMIT ?2)`)
        .bind(cutoffISO, this.batch.batchSize)
        .run();
      total += result.meta.changes;
      if (result.meta.changes < this.batch.batchSize) break;
    }
    return total;
  }
}
