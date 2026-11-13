import type { EntityType, QbEventRow, SyncStatus } from '../types';

export interface NewQbEvent {
  eventId: string;
  entityType: EntityType;
  qbId: string;
  receivedAt: string;
}

export interface QbEventStatusPatch {
  fetchedPayload?: string;
  pendingMondayItemId?: string;
  error?: string;
  writtenAt?: string;
}

// What recordEvents found for one row: a fresh insert, or the status of the row that was already
// there under that event id (a redelivery).
export type RecordResult = { inserted: true } | { inserted: false; status: SyncStatus };

export interface QbEventStore {
  // Inserts every row, skipping an event id already recorded, and reports each row's outcome in
  // input order. One D1 round trip per 100 rows (#101); the event ids must be distinct.
  recordEvents(rows: readonly NewQbEvent[]): Promise<RecordResult[]>;
  // Sets status (and error, cleared when omitted) on every listed row; one round trip per 100.
  markEvents(eventIds: readonly string[], status: SyncStatus, error?: string): Promise<void>;
  updateStatus(eventId: string, status: SyncStatus, patch?: QbEventStatusPatch): Promise<void>;
  getEvent(eventId: string): Promise<QbEventRow | null>;
  // The row whose Monday create produced `mondayItemId`, if its id was recorded (create-loop
  // guard, #33).
  findByPendingMondayItemId(entityType: EntityType, mondayItemId: string): Promise<QbEventRow | null>;
}

interface D1QbEventRecord {
  event_id: string;
  entity_type: EntityType;
  qb_id: string;
  fetched_payload: string | null;
  pending_monday_item_id: string | null;
  status: SyncStatus;
  error: string | null;
  received_at: string;
  written_at: string | null;
}

function toQbEventRow(record: D1QbEventRecord): QbEventRow {
  return {
    eventId: record.event_id,
    entityType: record.entity_type,
    qbId: record.qb_id,
    fetchedPayload: record.fetched_payload,
    pendingMondayItemId: record.pending_monday_item_id,
    status: record.status,
    error: record.error,
    receivedAt: record.received_at,
    writtenAt: record.written_at,
  };
}

// D1 binds at most 100 parameters per statement.
const D1_MAX_PARAMS = 100;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// "?1, ?2, …" numbered from `first`.
function placeholders(count: number, first = 1): string {
  return Array.from({ length: count }, (_, i) => `?${first + i}`).join(', ');
}

const SELECT_COLUMNS =
  'event_id, entity_type, qb_id, fetched_payload, pending_monday_item_id, status, error, received_at, written_at';

export class D1QbEventStore implements QbEventStore {
  constructor(private db: D1Database) {}

  async recordEvents(rows: readonly NewQbEvent[]): Promise<RecordResult[]> {
    const results: RecordResult[] = [];
    for (const part of chunks(rows, D1_MAX_PARAMS)) {
      const inserts = part.map((row) =>
        this.db
          .prepare(
            `INSERT INTO qb_events (event_id, entity_type, qb_id, status, received_at)
             VALUES (?1, ?2, ?3, 'received', ?4)
             ON CONFLICT (event_id) DO NOTHING`
          )
          .bind(row.eventId, row.entityType, row.qbId, row.receivedAt)
      );
      // The SELECT runs after the inserts in the same batch, so every id has a row by then.
      const select = this.db
        .prepare(`SELECT event_id, status FROM qb_events WHERE event_id IN (${placeholders(part.length)})`)
        .bind(...part.map((row) => row.eventId));
      const batch = await this.db.batch<{ event_id: string; status: SyncStatus }>([...inserts, select]);
      const statuses = new Map((batch.at(-1)?.results ?? []).map((r) => [r.event_id, r.status]));
      part.forEach((row, i) => {
        if ((batch[i]?.meta.changes ?? 0) > 0) {
          results.push({ inserted: true });
          return;
        }
        const status = statuses.get(row.eventId);
        if (status === undefined) throw new Error(`qb_events: no row for "${row.eventId}" after its insert`);
        results.push({ inserted: false, status });
      });
    }
    return results;
  }

  async markEvents(eventIds: readonly string[], status: SyncStatus, error?: string): Promise<void> {
    // Two parameters are status and error, so 98 ids per statement.
    for (const part of chunks(eventIds, D1_MAX_PARAMS - 2)) {
      await this.db
        .prepare(`UPDATE qb_events SET status = ?1, error = ?2 WHERE event_id IN (${placeholders(part.length, 3)})`)
        .bind(status, error ?? null, ...part)
        .run();
    }
  }

  async updateStatus(eventId: string, status: SyncStatus, patch: QbEventStatusPatch = {}): Promise<void> {
    await this.db
      .prepare(
        `UPDATE qb_events SET
           status = ?2,
           fetched_payload = COALESCE(?3, fetched_payload),
           pending_monday_item_id = COALESCE(?4, pending_monday_item_id),
           error = ?5,
           written_at = COALESCE(?6, written_at)
         WHERE event_id = ?1`
      )
      .bind(
        eventId,
        status,
        patch.fetchedPayload ?? null,
        patch.pendingMondayItemId ?? null,
        patch.error ?? null,
        patch.writtenAt ?? null
      )
      .run();
  }

  async getEvent(eventId: string): Promise<QbEventRow | null> {
    const record = await this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM qb_events WHERE event_id = ?1`)
      .bind(eventId)
      .first<D1QbEventRecord>();
    return record === null ? null : toQbEventRow(record);
  }

  async findByPendingMondayItemId(entityType: EntityType, mondayItemId: string): Promise<QbEventRow | null> {
    const record = await this.db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM qb_events
         WHERE entity_type = ?1 AND pending_monday_item_id = ?2
         ORDER BY received_at DESC LIMIT 1`
      )
      .bind(entityType, mondayItemId)
      .first<D1QbEventRecord>();
    return record === null ? null : toQbEventRow(record);
  }
}
