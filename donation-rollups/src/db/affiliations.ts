export interface AffiliationRow { affiliationItemId: string; personItemId: string; personBoardId: string; name: string }

// Affiliation item -> Person. Refreshed from Monday on every affiliation recompute (the
// consumer reads the item's Person link fresh), so this is a memory of the last-known person
// (to recompute someone an affiliation moved AWAY from) and the bootstrap seed — never the
// source of truth for the link itself.
export interface AffiliationsStore {
  upsert(row: AffiliationRow, updatedAt: string): Promise<void>;
  get(affiliationItemId: string): Promise<AffiliationRow | null>;
  forPerson(personItemId: string): Promise<AffiliationRow[]>;
  bulkUpsert(rows: (AffiliationRow & { updatedAt: string })[]): Promise<number>;
}

const UPSERT = `INSERT INTO affiliations (affiliation_item_id, person_item_id, person_board_id, name, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5)
  ON CONFLICT (affiliation_item_id) DO UPDATE SET
    person_item_id = excluded.person_item_id, person_board_id = excluded.person_board_id,
    name = excluded.name, updated_at = excluded.updated_at`;

interface Rec { affiliation_item_id: string; person_item_id: string; person_board_id: string; name: string }
const toRow = (r: Rec): AffiliationRow =>
  ({ affiliationItemId: r.affiliation_item_id, personItemId: r.person_item_id, personBoardId: r.person_board_id, name: r.name });

export class D1AffiliationsStore implements AffiliationsStore {
  constructor(private db: D1Database) {}

  async upsert(row: AffiliationRow, updatedAt: string): Promise<void> {
    await this.db.prepare(UPSERT).bind(row.affiliationItemId, row.personItemId, row.personBoardId, row.name, updatedAt).run();
  }
  async get(affiliationItemId: string): Promise<AffiliationRow | null> {
    const r = await this.db.prepare(`SELECT affiliation_item_id, person_item_id, person_board_id, name FROM affiliations WHERE affiliation_item_id = ?1`)
      .bind(affiliationItemId).first<Rec>();
    return r === null ? null : toRow(r);
  }
  async forPerson(personItemId: string): Promise<AffiliationRow[]> {
    const res = await this.db.prepare(`SELECT affiliation_item_id, person_item_id, person_board_id, name FROM affiliations WHERE person_item_id = ?1 ORDER BY affiliation_item_id`)
      .bind(personItemId).all<Rec>();
    return res.results.map(toRow);
  }
  async bulkUpsert(rows: (AffiliationRow & { updatedAt: string })[]): Promise<number> {
    const BATCH = 100;
    let written = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      await this.db.batch(chunk.map((r) => this.db.prepare(UPSERT)
        .bind(r.affiliationItemId, r.personItemId, r.personBoardId, r.name, r.updatedAt)));
      written += chunk.length;
    }
    return written;
  }
}
