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

export class D1SnapshotRunStore implements SnapshotRunStore {
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
}
