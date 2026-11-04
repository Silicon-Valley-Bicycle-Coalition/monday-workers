// The donor roll call's credit ledger (migration 0011): who each counted gift is credited to, so
// the nightly rollcall duty can diff against it and write only what changed. `credit` null means
// "the ledger credits this gift" — a row kept only to carry unmatchedMatch, a Recognition Fiscal
// Year or an in-kind amount (spec §10).
export interface CreditRow {
  giftItemId: string;
  fiscalYear: number;
  // The staff-set Recognition Fiscal Year (migration 0013), or null for the gift's own year.
  recognitionFiscalYear: number | null;
  // Amount, or the In-Kind Value when Amount is blank (spec §10.3).
  amountCents: number;
  status: string;
  giftType: string | null;
  credit: string | null;
  unmatchedMatch: boolean;
  archivedAt: string | null;
}

export interface RollCallCreditsStore {
  // Every year: a flagged gift keeps its row whatever year it reads now (see creditFor).
  all(): Promise<CreditRow[]>;
  // Diff-only, like GiftsStore.refreshFacts: reads the stored rows and writes only new or changed
  // ones. Returns how many rows it wrote.
  upsert(rows: CreditRow[], now: string): Promise<number>;
  remove(giftItemIds: string[]): Promise<void>;
  markArchived(giftItemIds: string[], now: string): Promise<void>;
}

interface D1Row {
  gift_item_id: string; fiscal_year: number; recognition_fiscal_year: number | null; amount_cents: number; status: string; gift_type: string | null;
  credit: string | null; unmatched_match: number; archived_at: string | null;
}

const CHUNK = 50;
const READ_CHUNK = 100;

const fromD1 = (r: D1Row): CreditRow => ({
  giftItemId: r.gift_item_id, fiscalYear: r.fiscal_year, recognitionFiscalYear: r.recognition_fiscal_year, amountCents: r.amount_cents, status: r.status,
  giftType: r.gift_type, credit: r.credit, unmatchedMatch: r.unmatched_match === 1, archivedAt: r.archived_at,
});

const differs = (a: CreditRow | undefined, b: CreditRow): boolean =>
  a === undefined || a.fiscalYear !== b.fiscalYear || a.recognitionFiscalYear !== b.recognitionFiscalYear || a.amountCents !== b.amountCents || a.status !== b.status
  || a.giftType !== b.giftType || a.credit !== b.credit || a.unmatchedMatch !== b.unmatchedMatch
  || a.archivedAt !== b.archivedAt;

export class D1RollCallCreditsStore implements RollCallCreditsStore {
  constructor(private db: D1Database) {}

  async all(): Promise<CreditRow[]> {
    const res = await this.db
      .prepare(`SELECT gift_item_id, fiscal_year, recognition_fiscal_year, amount_cents, status, gift_type, credit, unmatched_match, archived_at
                FROM roll_call_credits ORDER BY gift_item_id`)
      .all<D1Row>();
    return res.results.map(fromD1);
  }

  async upsert(rows: CreditRow[], now: string): Promise<number> {
    const stored = new Map<string, CreditRow>();
    for (let i = 0; i < rows.length; i += READ_CHUNK) {
      const ids = rows.slice(i, i + READ_CHUNK).map((r) => r.giftItemId);
      const res = await this.db
        .prepare(`SELECT gift_item_id, fiscal_year, recognition_fiscal_year, amount_cents, status, gift_type, credit, unmatched_match, archived_at
                  FROM roll_call_credits WHERE gift_item_id IN (${ids.map((_, n) => `?${n + 1}`).join(', ')})`)
        .bind(...ids)
        .all<D1Row>();
      for (const r of res.results) stored.set(r.gift_item_id, fromD1(r));
    }
    const changed = rows.filter((r) => differs(stored.get(r.giftItemId), r));

    for (let i = 0; i < changed.length; i += CHUNK) {
      await this.db.batch(changed.slice(i, i + CHUNK).map((r) => this.db
        .prepare(
          `INSERT INTO roll_call_credits (gift_item_id, fiscal_year, amount_cents, status, gift_type, credit,
             unmatched_match, archived_at, updated_at, recognition_fiscal_year)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT (gift_item_id) DO UPDATE SET
             fiscal_year = excluded.fiscal_year,
             recognition_fiscal_year = excluded.recognition_fiscal_year,
             amount_cents = excluded.amount_cents,
             status = excluded.status,
             gift_type = excluded.gift_type,
             credit = excluded.credit,
             unmatched_match = excluded.unmatched_match,
             archived_at = excluded.archived_at,
             updated_at = excluded.updated_at`,
        )
        .bind(r.giftItemId, r.fiscalYear, r.amountCents, r.status, r.giftType, r.credit,
          r.unmatchedMatch ? 1 : 0, r.archivedAt, now, r.recognitionFiscalYear)));
    }
    return changed.length;
  }

  async remove(giftItemIds: string[]): Promise<void> {
    for (let i = 0; i < giftItemIds.length; i += CHUNK) {
      await this.db.batch(giftItemIds.slice(i, i + CHUNK).map((id) => this.db
        .prepare(`DELETE FROM roll_call_credits WHERE gift_item_id = ?1`).bind(id)));
    }
  }

  async markArchived(giftItemIds: string[], now: string): Promise<void> {
    for (let i = 0; i < giftItemIds.length; i += CHUNK) {
      await this.db.batch(giftItemIds.slice(i, i + CHUNK).map((id) => this.db
        .prepare(`UPDATE roll_call_credits SET archived_at = ?2, updated_at = ?2 WHERE gift_item_id = ?1`)
        .bind(id, now)));
    }
  }
}
