export interface GiftFact {
  mondayItemId: string;
  ownerItemId: string;
  ownerBoardId: string;
  amountCents: number;
  giftDateISO: string; // '' when unknown
  fiscalYear: number; // 0 when undated
  status: string;
}

export interface AnnualSummaryRow {
  fiscalYear: number;
  totalCents: number;
  giftCount: number;
  byTypeJson: string;
  mondayItemId: string | null;
  restatedAt: string | null;
}

export interface CustodianRun {
  duty: string;
  ranAt: string;
  ok: boolean;
  report: unknown;
}

export interface GiftsStore {
  // Recompute-path refresh: re-asserts the webhook-visible facts of a gift while PRESERVING
  // bootstrap-only provenance (gift_type / funraise_id / sf_id) and archived_at, which the
  // webhook path can't see.
  refreshFacts(rows: GiftFact[], source: string, now: string): Promise<void>;
  // Active gifts older than the retention cutoff — the year-end archive run's work list.
  getArchivable(cutoffFY: number): Promise<{ mondayItemId: string; fiscalYear: number }[]>;
  markArchived(mondayItemIds: string[], now: string): Promise<void>;
  // Distinct owners, for the July full-recompute sweep — paired with one linked donation id
  // each, since the recompute queue is donation-keyed and any one gift triggers the owner's
  // full recompute. Ordered by owner id with a cursor so the sweep can slice itself.
  ownersWithOneGift(afterOwnerId?: string, limit?: number): Promise<{ ownerItemId: string; mondayItemId: string; donationBoardId: string }[]>;
  // Per-owner counted totals over gifts with the given status label — reconciliation's
  // ledger side.
  ownerTotals(statusLabel: string): Promise<Map<string, { cents: number; count: number; ownerBoardId: string }>>;
  // Closed-FY totals from the ledger, for materializing annual_summaries.
  fiscalYearTotals(statusLabel: string, beforeFY: number): Promise<{ fiscalYear: number; totalCents: number; giftCount: number; byTypeJson: string }[]>;
  upsertAnnualSummaries(rows: { fiscalYear: number; totalCents: number; giftCount: number; byTypeJson: string }[], now: string): Promise<{ changed: number[] }>;
  getAnnualSummaries(): Promise<AnnualSummaryRow[]>;
  recordRun(run: CustodianRun): Promise<void>;
  lastRuns(): Promise<{ duty: string; ranAt: string; ok: boolean; report: unknown }[]>;
}

const CHUNK = 50;

export class D1GiftsStore implements GiftsStore {
  constructor(private db: D1Database) {}

  async refreshFacts(rows: GiftFact[], source: string, now: string): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.db.batch(chunk.map((g) => this.db
        .prepare(
          `INSERT INTO gifts (monday_item_id, owner_item_id, owner_board_id, amount_cents,
             gift_date, fiscal_year, status, source, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
           ON CONFLICT (monday_item_id) DO UPDATE SET
             owner_item_id = excluded.owner_item_id,
             owner_board_id = excluded.owner_board_id,
             amount_cents = excluded.amount_cents,
             gift_date = excluded.gift_date,
             fiscal_year = excluded.fiscal_year,
             status = excluded.status,
             source = excluded.source,
             updated_at = excluded.updated_at`,
        )
        .bind(g.mondayItemId, g.ownerItemId, g.ownerBoardId, g.amountCents,
          g.giftDateISO, g.fiscalYear, g.status, source, now)));
    }
  }

  async getArchivable(cutoffFY: number): Promise<{ mondayItemId: string; fiscalYear: number }[]> {
    const res = await this.db
      .prepare(`SELECT monday_item_id, fiscal_year FROM gifts
                WHERE archived_at IS NULL AND fiscal_year < ?1 ORDER BY fiscal_year, monday_item_id`)
      .bind(cutoffFY)
      .all<{ monday_item_id: string; fiscal_year: number }>();
    return res.results.map((r) => ({ mondayItemId: r.monday_item_id, fiscalYear: r.fiscal_year }));
  }

  async markArchived(mondayItemIds: string[], now: string): Promise<void> {
    for (let i = 0; i < mondayItemIds.length; i += CHUNK) {
      const chunk = mondayItemIds.slice(i, i + CHUNK);
      await this.db.batch(chunk.map((id) => this.db
        .prepare(`UPDATE gifts SET archived_at = ?2, updated_at = ?2 WHERE monday_item_id = ?1`)
        .bind(id, now)));
    }
  }

  async ownersWithOneGift(afterOwnerId = '', limit = 100_000): Promise<{ ownerItemId: string; mondayItemId: string; donationBoardId: string }[]> {
    // donation_links carries the donation board id the queue message needs; gifts alone
    // doesn't. MIN() picks an arbitrary-but-stable representative gift per owner. Ordered +
    // cursored so the July sweep can slice itself under the Worker subrequest budget.
    const res = await this.db
      .prepare(`SELECT owner_item_id, MIN(donation_item_id) AS donation_item_id,
                       MIN(donation_board_id) AS donation_board_id
                FROM donation_links WHERE owner_item_id > ?1
                GROUP BY owner_item_id ORDER BY owner_item_id LIMIT ?2`)
      .bind(afterOwnerId, limit)
      .all<{ owner_item_id: string; donation_item_id: string; donation_board_id: string }>();
    return res.results.map((r) => ({
      ownerItemId: r.owner_item_id, mondayItemId: r.donation_item_id, donationBoardId: r.donation_board_id,
    }));
  }

  async ownerTotals(statusLabel: string): Promise<Map<string, { cents: number; count: number; ownerBoardId: string }>> {
    const res = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id, SUM(amount_cents) AS cents, COUNT(*) AS n
                FROM gifts WHERE status = ?1 GROUP BY owner_item_id, owner_board_id`)
      .bind(statusLabel)
      .all<{ owner_item_id: string; owner_board_id: string; cents: number; n: number }>();
    const out = new Map<string, { cents: number; count: number; ownerBoardId: string }>();
    for (const r of res.results) out.set(r.owner_item_id, { cents: r.cents, count: r.n, ownerBoardId: r.owner_board_id });
    return out;
  }

  async fiscalYearTotals(statusLabel: string, beforeFY: number): Promise<{ fiscalYear: number; totalCents: number; giftCount: number; byTypeJson: string }[]> {
    // gift_type is bootstrap-provenance and may be null for webhook-born gifts; bucket
    // those as '(unknown)' rather than dropping them from the by-type split.
    const res = await this.db
      .prepare(`SELECT fiscal_year, COALESCE(gift_type, '(unknown)') AS gift_type,
                       SUM(amount_cents) AS cents, COUNT(*) AS n
                FROM gifts WHERE status = ?1 AND fiscal_year < ?2
                GROUP BY fiscal_year, gift_type ORDER BY fiscal_year`)
      .bind(statusLabel, beforeFY)
      .all<{ fiscal_year: number; gift_type: string; cents: number; n: number }>();
    const byFY = new Map<number, { totalCents: number; giftCount: number; byType: Record<string, number> }>();
    for (const r of res.results) {
      const e = byFY.get(r.fiscal_year) ?? { totalCents: 0, giftCount: 0, byType: {} };
      e.totalCents += r.cents;
      e.giftCount += r.n;
      e.byType[r.gift_type] = (e.byType[r.gift_type] ?? 0) + r.cents;
      byFY.set(r.fiscal_year, e);
    }
    return [...byFY.entries()].map(([fiscalYear, e]) => ({
      fiscalYear, totalCents: e.totalCents, giftCount: e.giftCount, byTypeJson: JSON.stringify(e.byType),
    }));
  }

  async upsertAnnualSummaries(rows: { fiscalYear: number; totalCents: number; giftCount: number; byTypeJson: string }[], now: string): Promise<{ changed: number[] }> {
    const existing = await this.getAnnualSummaries();
    const before = new Map(existing.map((s) => [s.fiscalYear, s]));
    const changed: number[] = [];
    for (const r of rows) {
      const prev = before.get(r.fiscalYear);
      if (prev && prev.totalCents === r.totalCents && prev.giftCount === r.giftCount) continue;
      // A changed CLOSED year is a restatement (audit edits flow through here) — stamp it.
      const restated = prev !== undefined;
      changed.push(r.fiscalYear);
      await this.db
        .prepare(
          `INSERT INTO annual_summaries (fiscal_year, total_cents, gift_count, by_type_json, restated_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)
           ON CONFLICT (fiscal_year) DO UPDATE SET
             total_cents = excluded.total_cents,
             gift_count = excluded.gift_count,
             by_type_json = excluded.by_type_json,
             restated_at = excluded.restated_at,
             updated_at = excluded.updated_at`,
        )
        .bind(r.fiscalYear, r.totalCents, r.giftCount, r.byTypeJson, restated ? now : null, now)
        .run();
    }
    return { changed };
  }

  async getAnnualSummaries(): Promise<AnnualSummaryRow[]> {
    const res = await this.db
      .prepare(`SELECT fiscal_year, total_cents, gift_count, by_type_json, monday_item_id, restated_at
                FROM annual_summaries ORDER BY fiscal_year`)
      .all<{ fiscal_year: number; total_cents: number; gift_count: number; by_type_json: string; monday_item_id: string | null; restated_at: string | null }>();
    return res.results.map((r) => ({
      fiscalYear: r.fiscal_year, totalCents: r.total_cents, giftCount: r.gift_count,
      byTypeJson: r.by_type_json, mondayItemId: r.monday_item_id, restatedAt: r.restated_at,
    }));
  }

  async recordRun(run: CustodianRun): Promise<void> {
    await this.db
      .prepare(`INSERT INTO custodian_runs (duty, ran_at, ok, report_json) VALUES (?1, ?2, ?3, ?4)`)
      .bind(run.duty, run.ranAt, run.ok ? 1 : 0, JSON.stringify(run.report))
      .run();
  }

  async lastRuns(): Promise<{ duty: string; ranAt: string; ok: boolean; report: unknown }[]> {
    const res = await this.db
      .prepare(`SELECT duty, ran_at, ok, report_json FROM custodian_runs r
                WHERE ran_at = (SELECT MAX(ran_at) FROM custodian_runs WHERE duty = r.duty)
                GROUP BY duty`)
      .all<{ duty: string; ran_at: string; ok: number; report_json: string }>();
    return res.results.map((r) => ({
      duty: r.duty, ranAt: r.ran_at, ok: r.ok === 1, report: JSON.parse(r.report_json),
    }));
  }
}
