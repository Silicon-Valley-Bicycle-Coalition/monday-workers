// Event Registrations check-ins (and the 2014-2020 Volunteers board, loaded once) as
// membership activity — spec 2026-10-09 "Volunteer activity in D1". One row per registration
// item; the consumer folds qualifying rows into the owner's runs next to their gifts.
export type VolunteerSource = 'webhook' | 'sweep' | 'historical';

export interface VolunteerActivityRow {
  registrationItemId: string;
  boardId: string;
  ownerItemId: string | null;
  ownerBoardId: string | null;
  activityDateISO: string | null;
  hours: number | null;
  qualifies: boolean;
  source: VolunteerSource;
}

export interface VolunteerActivityStore {
  // Returns the owner the row pointed at before, when this write moved it to someone else —
  // the consumer recomputes that person too (same shape as a Donor-link re-point).
  upsert(row: VolunteerActivityRow, now: string): Promise<{ previousOwner: { ownerItemId: string; ownerBoardId: string } | null }>;
  forOwner(ownerItemId: string): Promise<VolunteerActivityRow[]>;
  // A deleted registration: keep the row, stop it counting, and say who it counted for.
  markRemoved(registrationItemId: string, now: string): Promise<{ ownerItemId: string; ownerBoardId: string } | null>;
  // Distinct owners with at least one qualifying row, cursored by owner id — the membership
  // duty's "people with check-ins but no gift" source.
  ownersWithActivity(afterOwnerId: string, limit: number): Promise<{ ownerItemId: string; ownerBoardId: string }[]>;
}

interface D1Row {
  registration_item_id: string; board_id: string; owner_item_id: string | null; owner_board_id: string | null;
  activity_date: string | null; hours: number | null; qualifies: number; source: VolunteerSource;
}

const fromRow = (r: D1Row): VolunteerActivityRow => ({
  registrationItemId: r.registration_item_id, boardId: r.board_id,
  ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id,
  activityDateISO: r.activity_date, hours: r.hours, qualifies: r.qualifies === 1, source: r.source,
});

export class D1VolunteerActivityStore implements VolunteerActivityStore {
  constructor(private db: D1Database) {}

  async upsert(row: VolunteerActivityRow, now: string) {
    const before = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id FROM volunteer_activity WHERE registration_item_id = ?1`)
      .bind(row.registrationItemId)
      .first<{ owner_item_id: string | null; owner_board_id: string | null }>();
    await this.db
      .prepare(`INSERT INTO volunteer_activity (registration_item_id, board_id, owner_item_id, owner_board_id,
                  activity_date, hours, qualifies, source, updated_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ON CONFLICT (registration_item_id) DO UPDATE SET
                  board_id = excluded.board_id, owner_item_id = excluded.owner_item_id,
                  owner_board_id = excluded.owner_board_id, activity_date = excluded.activity_date,
                  hours = excluded.hours, qualifies = excluded.qualifies, source = excluded.source,
                  updated_at = excluded.updated_at`)
      .bind(row.registrationItemId, row.boardId, row.ownerItemId, row.ownerBoardId,
        row.activityDateISO, row.hours, row.qualifies ? 1 : 0, row.source, now)
      .run();
    const moved = before !== null && before.owner_item_id !== null && before.owner_item_id !== row.ownerItemId;
    return { previousOwner: moved ? { ownerItemId: before.owner_item_id!, ownerBoardId: before.owner_board_id ?? '' } : null };
  }

  async forOwner(ownerItemId: string): Promise<VolunteerActivityRow[]> {
    const res = await this.db
      .prepare(`SELECT registration_item_id, board_id, owner_item_id, owner_board_id, activity_date, hours, qualifies, source
                FROM volunteer_activity WHERE owner_item_id = ?1 AND qualifies = 1
                ORDER BY activity_date, registration_item_id`)
      .bind(ownerItemId)
      .all<D1Row>();
    return res.results.map(fromRow);
  }

  async markRemoved(registrationItemId: string, now: string) {
    const r = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id FROM volunteer_activity WHERE registration_item_id = ?1`)
      .bind(registrationItemId)
      .first<{ owner_item_id: string | null; owner_board_id: string | null }>();
    if (r === null) return null;
    await this.db
      .prepare(`UPDATE volunteer_activity SET qualifies = 0, updated_at = ?2 WHERE registration_item_id = ?1`)
      .bind(registrationItemId, now)
      .run();
    return r.owner_item_id === null ? null : { ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id ?? '' };
  }

  async ownersWithActivity(afterOwnerId: string, limit: number) {
    const res = await this.db
      .prepare(`SELECT owner_item_id, MIN(owner_board_id) AS owner_board_id FROM volunteer_activity
                WHERE qualifies = 1 AND owner_item_id IS NOT NULL AND owner_item_id > ?1
                GROUP BY owner_item_id ORDER BY owner_item_id LIMIT ?2`)
      .bind(afterOwnerId, limit)
      .all<{ owner_item_id: string; owner_board_id: string }>();
    return res.results.map((r) => ({ ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id }));
  }
}
