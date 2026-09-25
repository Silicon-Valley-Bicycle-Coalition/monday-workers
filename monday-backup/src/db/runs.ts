import type { WatchdogStore } from '../watchdog';

export interface RunResult {
  status: 'success' | 'partial';
  boardCount: number;
  docCount: number;
  errorCount: number;
  lastError: string | null;
}

export interface SnapshotRunStore {
  recordRunStart(startedAtUtc: string): Promise<number>;
  // Run completed (possibly with some board/doc errors folded into `result`) — resets the
  // consecutive-total-failure counter, since the run did produce a snapshot.
  recordRunFinish(runId: number, finishedAtUtc: string, result: RunResult): Promise<void>;
  // The run aborted entirely (e.g. Drive auth failed before any upload happened) — no
  // snapshot was produced at all. Returns the new consecutive-failure count for alerting.
  recordRunFailure(runId: number, finishedAtUtc: string, errorMessage: string): Promise<number>;
}

export class D1SnapshotRunStore implements SnapshotRunStore, WatchdogStore {
  constructor(private db: D1Database) {}

  async recordRunStart(startedAtUtc: string): Promise<number> {
    const result = await this.db
      .prepare(`INSERT INTO snapshot_runs (started_at, status) VALUES (?1, 'running') RETURNING id`)
      .bind(startedAtUtc)
      .first<{ id: number }>();
    if (result === null) {
      throw new Error('db: recordRunStart returned no row');
    }
    return result.id;
  }

  async recordRunFinish(runId: number, finishedAtUtc: string, result: RunResult): Promise<void> {
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE snapshot_runs
           SET finished_at = ?2, status = ?3, board_count = ?4, doc_count = ?5, error_count = ?6, last_error = ?7
           WHERE id = ?1`,
        )
        .bind(runId, finishedAtUtc, result.status, result.boardCount, result.docCount, result.errorCount, result.lastError),
      this.db.prepare(`UPDATE run_alert_state SET consecutive_failures = 0 WHERE id = 1`),
    ]);
  }

  async recordRunFailure(runId: number, finishedAtUtc: string, errorMessage: string): Promise<number> {
    await this.db
      .prepare(
        `UPDATE snapshot_runs SET finished_at = ?2, status = 'failure', error_count = 1, last_error = ?3 WHERE id = ?1`,
      )
      .bind(runId, finishedAtUtc, errorMessage)
      .run();
    const result = await this.db
      .prepare(
        `UPDATE run_alert_state SET consecutive_failures = consecutive_failures + 1 WHERE id = 1
         RETURNING consecutive_failures`,
      )
      .first<{ consecutive_failures: number }>();
    if (result === null) {
      throw new Error('db: recordRunFailure returned no row');
    }
    return result.consecutive_failures;
  }

  async abandonStaleRuns(cutoffUtc: string, finishedAtUtc: string): Promise<{ id: number; startedAt: string }[]> {
    const { results } = await this.db
      .prepare(
        `UPDATE snapshot_runs
         SET status = 'abandoned', finished_at = ?2, error_count = 1,
             last_error = 'run never finished — killed by the runtime (CPU/wall-time limit) or crashed before recording a result'
         WHERE status = 'running' AND started_at < ?1
         RETURNING id, started_at`,
      )
      .bind(cutoffUtc, finishedAtUtc)
      .all<{ id: number; started_at: string }>();
    if (results.length > 0) {
      await this.db
        .prepare(`UPDATE run_alert_state SET consecutive_failures = consecutive_failures + ?1 WHERE id = 1`)
        .bind(results.length)
        .run();
    }
    return results.map((r) => ({ id: r.id, startedAt: r.started_at }));
  }

  async lastSnapshotAt(): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT MAX(finished_at) AS at FROM snapshot_runs WHERE status IN ('success', 'partial')`)
      .first<{ at: string | null }>();
    return row?.at ?? null;
  }

  async armWatchdog(nowUtc: string): Promise<string> {
    const row = await this.db
      .prepare(
        `UPDATE run_alert_state SET watchdog_armed_at = COALESCE(watchdog_armed_at, ?1) WHERE id = 1
         RETURNING watchdog_armed_at`,
      )
      .bind(nowUtc)
      .first<{ watchdog_armed_at: string }>();
    if (row === null) {
      throw new Error('db: armWatchdog returned no row');
    }
    return row.watchdog_armed_at;
  }

  async lastStaleAlertAt(): Promise<string | null> {
    const row = await this.db
      .prepare(`SELECT last_stale_alert_at FROM run_alert_state WHERE id = 1`)
      .first<{ last_stale_alert_at: string | null }>();
    return row?.last_stale_alert_at ?? null;
  }

  async recordStaleAlert(nowUtc: string): Promise<void> {
    await this.db.prepare(`UPDATE run_alert_state SET last_stale_alert_at = ?1 WHERE id = 1`).bind(nowUtc).run();
  }
}
