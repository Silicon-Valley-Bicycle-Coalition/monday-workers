import type { EntityType, MapEntry } from '../types';

export interface MapStore {
  getByQbId(entityType: EntityType, qbId: string): Promise<MapEntry | null>;
  getByMondayItemId(entityType: EntityType, mondayItemId: string): Promise<MapEntry | null>;
  createMapping(entry: MapEntry): Promise<void>;
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
      // The upsert only resolves the (entity_type, qb_id) primary-key conflict. The separate
      // unique index on (entity_type, monday_item_id) can still fire when two different qb_ids
      // try to claim the same Monday item — surface that as a named application error rather
      // than a raw SQLite constraint message.
      if (isUniqueConstraintError(err)) {
        throw new Error(
          `qb_monday_map: monday_item_id "${entry.mondayItemId}" is already mapped to a different qb_id for entity type "${entry.entityType}"`
        );
      }
      throw err;
    }
  }
}
