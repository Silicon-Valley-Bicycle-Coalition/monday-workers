// The D1 ledger: one row per pass, one per decided move, one per capacity alert. It is what makes
// a pass auditable (what moved, why, on which date's evidence) and idempotent (a run_id that
// already finished is not re-run; a 'planned' row from an interrupted pass is settled, not
// repeated). See migrations/0001_create_ledger.sql.

export type RunTrigger = 'quarterly' | 'threshold' | 'continuation' | 'http' | 'single-move';
export type RunStatus = 'running' | 'ok' | 'failed';
export type MoveStatus = 'dry-run' | 'planned' | 'moved' | 'failed' | 'ambiguous';
export type Direction = 'to-historical' | 'to-live';

export interface RunRow {
  runId: string;
  trigger: RunTrigger;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  summary: unknown | null;
}

export interface MoveRow {
  id: number;
  runId: string;
  itemId: string;
  fromBoardId: string;
  toBoardId: string;
  direction: Direction;
  latestActivity: string | null;
  reason: string;
  status: MoveStatus;
  error: string | null;
  plannedAt: string;
  movedAt: string | null;
}

export interface NewMove {
  runId: string; itemId: string; fromBoardId: string; toBoardId: string; direction: Direction;
  latestActivity: string | null; reason: string; status: MoveStatus; plannedAt: string;
}

export interface Ledger {
  // Inserts the run, or returns the existing row when this run_id has been seen before.
  startRun(run: { runId: string; trigger: RunTrigger; dryRun: boolean; startedAt: string }): Promise<{ created: boolean; existing: RunRow | null }>;
  finishRun(runId: string, status: Exclude<RunStatus, 'running'>, finishedAt: string, summary: unknown): Promise<void>;
  recentRuns(limit: number): Promise<RunRow[]>;
  // passesOnly leaves out HTTP dry runs (an operator's `?dryRun=true` preview) and single-person
  // moves, which must not count as "the last pass" when the cron decides whether one is due.
  lastRun(filter?: { trigger?: RunTrigger; dryRun?: boolean; passesOnly?: boolean }): Promise<RunRow | null>;
  insertMove(move: NewMove): Promise<number>;
  setMoveStatus(id: number, status: MoveStatus, at: string, error?: string | null): Promise<void>;
  unsettledMoves(): Promise<MoveRow[]>;
  lastAlertAt(boardId: string, kind: string): Promise<string | null>;
  recordAlert(boardId: string, kind: string, createdAt: string, alertItemId: string | null): Promise<void>;
  // The one-pass-at-a-time lease (migrations/0002_pass_lease.sql). acquireLease is true when this
  // holder now holds it: it was free, or the previous holder's lease had expired.
  acquireLease(holder: string, nowISO: string, expiresAtISO: string): Promise<boolean>;
  releaseLease(holder: string): Promise<void>;
}

interface RawRun { run_id: string; trigger: string; dry_run: number; started_at: string; finished_at: string | null; status: string; summary_json: string | null }
interface RawMove {
  id: number; run_id: string; item_id: string; from_board_id: string; to_board_id: string; direction: string;
  latest_activity: string | null; reason: string; status: string; error: string | null; planned_at: string; moved_at: string | null;
}

const toRun = (r: RawRun): RunRow => ({
  runId: r.run_id, trigger: r.trigger as RunTrigger, dryRun: r.dry_run === 1, startedAt: r.started_at,
  finishedAt: r.finished_at, status: r.status as RunStatus, summary: r.summary_json === null ? null : JSON.parse(r.summary_json),
});
const toMove = (r: RawMove): MoveRow => ({
  id: r.id, runId: r.run_id, itemId: r.item_id, fromBoardId: r.from_board_id, toBoardId: r.to_board_id,
  direction: r.direction as Direction, latestActivity: r.latest_activity, reason: r.reason, status: r.status as MoveStatus,
  error: r.error, plannedAt: r.planned_at, movedAt: r.moved_at,
});

export class D1Ledger implements Ledger {
  constructor(private readonly db: D1Database) {}

  async startRun(run: { runId: string; trigger: RunTrigger; dryRun: boolean; startedAt: string }) {
    const existing = await this.db.prepare('SELECT * FROM runs WHERE run_id = ?').bind(run.runId).first<RawRun>();
    if (existing !== null) return { created: false, existing: toRun(existing) };
    await this.db.prepare('INSERT INTO runs (run_id, trigger, dry_run, started_at, status) VALUES (?, ?, ?, ?, ?)')
      .bind(run.runId, run.trigger, run.dryRun ? 1 : 0, run.startedAt, 'running').run();
    return { created: true, existing: null };
  }

  async finishRun(runId: string, status: Exclude<RunStatus, 'running'>, finishedAt: string, summary: unknown): Promise<void> {
    await this.db.prepare('UPDATE runs SET status = ?, finished_at = ?, summary_json = ? WHERE run_id = ?')
      .bind(status, finishedAt, JSON.stringify(summary), runId).run();
  }

  async recentRuns(limit: number): Promise<RunRow[]> {
    const { results } = await this.db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').bind(limit).all<RawRun>();
    return results.map(toRun);
  }

  async lastRun(filter: { trigger?: RunTrigger; dryRun?: boolean; passesOnly?: boolean } = {}): Promise<RunRow | null> {
    const where: string[] = [];
    const binds: unknown[] = [];
    if (filter.trigger !== undefined) { where.push('trigger = ?'); binds.push(filter.trigger); }
    if (filter.dryRun !== undefined) { where.push('dry_run = ?'); binds.push(filter.dryRun ? 1 : 0); }
    if (filter.passesOnly) where.push("NOT (trigger = 'http' AND dry_run = 1) AND trigger <> 'single-move'");
    const sql = `SELECT * FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT 1`;
    const row = await this.db.prepare(sql).bind(...binds).first<RawRun>();
    return row === null ? null : toRun(row);
  }

  async insertMove(m: NewMove): Promise<number> {
    const row = await this.db.prepare(
      `INSERT INTO moves (run_id, item_id, from_board_id, to_board_id, direction, latest_activity, reason, status, planned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    ).bind(m.runId, m.itemId, m.fromBoardId, m.toBoardId, m.direction, m.latestActivity, m.reason, m.status, m.plannedAt).first<{ id: number }>();
    return row!.id;
  }

  async setMoveStatus(id: number, status: MoveStatus, at: string, error: string | null = null): Promise<void> {
    await this.db.prepare('UPDATE moves SET status = ?, error = ?, moved_at = CASE WHEN ? = \'moved\' THEN ? ELSE moved_at END WHERE id = ?')
      .bind(status, error, status, at, id).run();
  }

  async unsettledMoves(): Promise<MoveRow[]> {
    const { results } = await this.db.prepare("SELECT * FROM moves WHERE status IN ('planned', 'ambiguous') ORDER BY id").all<RawMove>();
    return results.map(toMove);
  }

  async lastAlertAt(boardId: string, kind: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT created_at FROM alerts WHERE board_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
      .bind(boardId, kind).first<{ created_at: string }>();
    return row?.created_at ?? null;
  }

  async recordAlert(boardId: string, kind: string, createdAt: string, alertItemId: string | null): Promise<void> {
    await this.db.prepare('INSERT INTO alerts (board_id, kind, created_at, alert_item_id) VALUES (?, ?, ?, ?)')
      .bind(boardId, kind, createdAt, alertItemId).run();
  }

  async acquireLease(holder: string, nowISO: string, expiresAtISO: string): Promise<boolean> {
    const row = await this.db
      .prepare(`INSERT INTO pass_lease (id, holder, expires_at) VALUES (1, ?1, ?2)
                ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
                WHERE pass_lease.expires_at <= ?3
                RETURNING holder`)
      .bind(holder, expiresAtISO, nowISO)
      .first<{ holder: string }>();
    return row?.holder === holder;
  }

  async releaseLease(holder: string): Promise<void> {
    await this.db.prepare('DELETE FROM pass_lease WHERE id = 1 AND holder = ?').bind(holder).run();
  }
}
