import { TerminalError } from '../errors';
import type { EntityType, MapEntry } from '../types';

export interface MapStore {
  getByQbId(entityType: EntityType, qbId: string): Promise<MapEntry | null>;
  getByMondayItemId(entityType: EntityType, mondayItemId: string): Promise<MapEntry | null>;
  // Links a QuickBooks record to a Monday item. Idempotent for the same pair; if the record is
  // already linked to a *different* item it throws MappingConflictError and changes nothing
  // (#33 review — it used to upsert, silently re-pointing the record).
  createMapping(entry: MapEntry): Promise<void>;
  // Deliberately moves a record's link to another item (the caller has established the old item
  // is archived or deleted).
  repointMapping(entry: MapEntry): Promise<void>;
}

// Two Monday items stand for one QuickBooks record. Terminal: retrying can't choose between them.
export class MappingConflictError extends TerminalError {
  constructor(
    readonly entityType: EntityType,
    readonly qbId: string,
    readonly existingMondayItemId: string,
    readonly attemptedMondayItemId: string
  ) {
    super(
      `QuickBooks ${entityType} ${qbId} already has Monday item "${existingMondayItemId}", and item "${attemptedMondayItemId}" also stands for it — archive the duplicate item in Monday, then redrive this row`
    );
    this.name = 'MappingConflictError';
  }
}

interface D1MapRecord {
  entity_type: EntityType;
  qb_id: string;
  monday_item_id: string;
  monday_board_id: number;
  created_at: string;
}

function toMapEntry(record: D1MapRecord): MapEntry {
  return {
    entityType: record.entity_type,
    qbId: record.qb_id,
    mondayItemId: record.monday_item_id,
    mondayBoardId: record.monday_board_id,
    createdAt: record.created_at,
  };
}

const SELECT_COLUMNS = 'entity_type, qb_id, monday_item_id, monday_board_id, created_at';

// D1 surfaces SQLite constraint failures as an Error whose message carries SQLite's own text,
// typically wrapped as `D1_ERROR: UNIQUE constraint failed: ...`.
function isUniqueConstraintError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(message);
}

// The (entity_type, monday_item_id) unique index fires when two different qb_ids claim the same
// Monday item. Named and terminal rather than a raw SQLite message retried into the DLQ.
function itemAlreadyMapped(entry: MapEntry): TerminalError {
  return new TerminalError(
    `qb_monday_map: monday_item_id "${entry.mondayItemId}" is already mapped to a different qb_id for entity type "${entry.entityType}"`
  );
}

export class D1MapStore implements MapStore {
  constructor(private db: D1Database) {}

  async getByQbId(entityType: EntityType, qbId: string): Promise<MapEntry | null> {
    const record = await this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM qb_monday_map WHERE entity_type = ?1 AND qb_id = ?2`)
      .bind(entityType, qbId)
      .first<D1MapRecord>();
    return record === null ? null : toMapEntry(record);
  }

  async getByMondayItemId(entityType: EntityType, mondayItemId: string): Promise<MapEntry | null> {
    const record = await this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM qb_monday_map WHERE entity_type = ?1 AND monday_item_id = ?2`)
      .bind(entityType, mondayItemId)
      .first<D1MapRecord>();
    return record === null ? null : toMapEntry(record);
  }

  async createMapping(entry: MapEntry): Promise<void> {
    let inserted: boolean;
    try {
      const result = await this.db
        .prepare(
          `INSERT INTO qb_monday_map (entity_type, qb_id, monday_item_id, monday_board_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (entity_type, qb_id) DO NOTHING`
        )
        .bind(entry.entityType, entry.qbId, entry.mondayItemId, entry.mondayBoardId, entry.createdAt)
        .run();
      inserted = result.meta.changes > 0;
    } catch (err) {
      if (isUniqueConstraintError(err)) throw itemAlreadyMapped(entry);
      throw err;
    }
    if (inserted) return;
    const existing = await this.getByQbId(entry.entityType, entry.qbId);
    if (existing !== null && existing.mondayItemId !== entry.mondayItemId) {
      throw new MappingConflictError(entry.entityType, entry.qbId, existing.mondayItemId, entry.mondayItemId);
    }
  }

  async repointMapping(entry: MapEntry): Promise<void> {
    try {
      await this.db
        .prepare(
          `INSERT INTO qb_monday_map (entity_type, qb_id, monday_item_id, monday_board_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (entity_type, qb_id) DO UPDATE SET
             monday_item_id = excluded.monday_item_id,
             monday_board_id = excluded.monday_board_id`
        )
        .bind(entry.entityType, entry.qbId, entry.mondayItemId, entry.mondayBoardId, entry.createdAt)
        .run();
    } catch (err) {
      if (isUniqueConstraintError(err)) throw itemAlreadyMapped(entry);
      throw err;
    }
  }
}
