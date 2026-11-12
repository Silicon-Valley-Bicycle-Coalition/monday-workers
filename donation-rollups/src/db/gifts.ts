export interface OwnerFilter { ownerBoardId: string; giftTypes: string[] }

export interface GiftFact {
  mondayItemId: string;
  ownerItemId: string;
  ownerBoardId: string;
  amountCents: number;
  giftDateISO: string; // '' when unknown
  fiscalYear: number; // 0 when undated
  status: string;
  // Present when the donation board's Gift Type column is configured — refreshes the
  // bootstrap value; null/undefined leaves the stored value untouched.
  giftType?: string | null;
  actingForItemId?: string | null; // undefined = column not configured, leave stored value
  // Migrated Term Start — undefined = column not configured, leave stored
  termStart?: string | null;
  // Sponsorship facts — undefined = not configured, leave stored (same rule as termStart).
  sponsorshipEvent?: string | null;   // resolved label, '' when read and blank
  inKindValueCents?: number | null;   // 0 when read and blank
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
  // webhook path can't see. Diff-only: reads the stored facts first and writes only the gifts
  // whose facts differ (or are new), so re-asserting an unchanged history costs reads, not
  // rows written — D1's Free-tier daily row-write cap is what stalled the consumer on
  // 2026-09-03 and 09-09 (README "operational findings"). Returns how many rows it wrote.
  refreshFacts(rows: GiftFact[], source: string, now: string): Promise<{ changed: number }>;
  // Full gift history for one owner, deep-link board ids joined in — the projections' source.
  giftsForOwner(ownerItemId: string): Promise<import('../projections/giftHistory').GiftHistoryRow[]>;
  // Takes a gift out of every total (issue #26): the item was deleted on Monday, or staff cleared
  // its Donor link. Returns the owner and acting-for it had, so the caller can recompute them;
  // null when the ledger never knew the gift. A later recompute that sees it again (restore,
  // re-link) clears the mark via refreshFacts.
  markRemoved(mondayItemId: string, now: string): Promise<{ ownerItemId: string; ownerBoardId: string; actingForItemId: string | null } | null>;
  // acting_for_item_id per gift, for the affiliation recompute path.
  actingForByIds(mondayItemIds: string[]): Promise<Map<string, string | null>>;
  // Attributed totals for one affiliation: Received gifts whose acting_for_item_id matches it.
  attributedTotals(affiliationItemId: string, statusLabel: string): Promise<{ cents: number; count: number; lastGiftDateISO: string | null }>;
  // Organizational Giving: totals across every affiliation belonging to a person.
  organizationalGivingTotals(personItemId: string, statusLabel: string): Promise<{ cents: number; count: number }>;
  // Reconciliation's ledger side for legs 5/6: every affiliation's attributed total (leg 5)
  // and every person's Organizational Giving total (leg 6), in one pass each rather than
  // one query per affiliation/person.
  attributedTotalsAll(statusLabel: string): Promise<Map<string, { cents: number; count: number }>>;
  organizationalGivingAll(statusLabel: string): Promise<Map<string, { cents: number; personBoardId: string }>>;
  // Records which Monday item on the Annual Giving Summary board represents a fiscal year.
  setSummaryItemId(fiscalYear: number, mondayItemId: string): Promise<void>;
  // Active gifts older than the retention cutoff — the year-end archive run's work list.
  getArchivable(cutoffFY: number): Promise<{ mondayItemId: string; fiscalYear: number }[]>;
  markArchived(mondayItemIds: string[], now: string): Promise<void>;
  // Every live gift (not removed) from a fiscal year on, archived or not — the donor roll call's
  // source for the credits it computes — plus any of alsoIds from an earlier year (a gift whose
  // Recognition Fiscal Year moves it into the covered years, spec §10.1).
  countedGifts(fromFY: number, alsoIds?: string[]): Promise<{ mondayItemId: string; ownerItemId: string; fiscalYear: number;
    amountCents: number; status: string; giftType: string | null }[]>;
  // Pre-cutover gifts whose migrated Term Start has never been read from the board (NULL, not
  // '' — a read blank is stored as '' so the backfill never re-reads it).
  giftsMissingTermStart(beforeISO: string, afterItemId: string, limit: number): Promise<string[]>;
  setTermStarts(rows: { mondayItemId: string; termStart: string }[], now: string): Promise<void>;
  // Live gifts (archived included) of the given types whose sponsorship facts were never read
  // (NULL, not ''/0 — a read blank is stored so the backfill never re-reads it).
  giftsMissingSponsorshipFacts(giftTypes: string[], afterItemId: string, limit: number): Promise<string[]>;
  // Overwrites only NULL facts, so a row selected for one missing fact can't clobber the other.
  setSponsorshipFacts(rows: { mondayItemId: string; sponsorshipEvent: string; inKindValueCents: number }[], now: string): Promise<void>;
  // Distinct owners with at least one live (not removed) gift, on the given owner boards — the
  // membership duty's all=true enqueue set, alongside owners with a qualifying check-in.
  ownersOnBoards(boardIds: string[]): Promise<{ ownerItemId: string; ownerBoardId: string }[]>;
  // Distinct owners, for the July full-recompute sweep — paired with one linked donation id
  // each, since the recompute queue is donation-keyed and any one gift triggers the owner's
  // full recompute. Ordered by owner id with a cursor so the sweep can slice itself.
  ownersWithOneGift(afterOwnerId?: string, limit?: number, only?: OwnerFilter): Promise<{ ownerItemId: string; ownerBoardId: string; mondayItemId: string; donationBoardId: string }[]>;
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
// D1 caps bound parameters at 100 per statement — the diff read binds one id each.
const READ_CHUNK = 100;

interface StoredFacts {
  monday_item_id: string;
  owner_item_id: string;
  owner_board_id: string;
  amount_cents: number;
  gift_date: string;
  fiscal_year: number;
  status: string;
  gift_type: string | null;
  acting_for_item_id: string | null;
  term_start: string | null;
  sponsorship_event: string | null;
  in_kind_value_cents: number | null;
  archived_at: string | null;
  removed_at: string | null;
}

// A gift needs writing when it's new or any webhook-visible fact differs. giftType is the one
// field the webhook path may not know: null/undefined means "leave stored", so only a present,
// different value counts (mirrors the COALESCE in the upsert below). actingForItemId follows the
// upsert's CASE: undefined never counts, and an archived gift keeps D1's value whatever Monday
// says now, so only an active gift with a supplied, different value (including a clear to null)
// is a change. termStart follows giftType: undefined means "leave stored", so only a present,
// different value counts.
function factsDiffer(stored: StoredFacts | undefined, g: GiftFact): boolean {
  if (stored === undefined) return true;
  return stored.removed_at !== null
    || stored.owner_item_id !== g.ownerItemId
    || stored.owner_board_id !== g.ownerBoardId
    || stored.amount_cents !== g.amountCents
    || stored.gift_date !== g.giftDateISO
    || stored.fiscal_year !== g.fiscalYear
    || stored.status !== g.status
    || (g.giftType != null && g.giftType !== stored.gift_type)
    || (g.actingForItemId !== undefined && stored.archived_at === null && g.actingForItemId !== stored.acting_for_item_id)
    || (g.termStart != null && g.termStart !== stored.term_start)
    || (g.sponsorshipEvent != null && g.sponsorshipEvent !== stored.sponsorship_event)
    || (g.inKindValueCents != null && g.inKindValueCents !== stored.in_kind_value_cents);
}

export class D1GiftsStore implements GiftsStore {
  constructor(private db: D1Database) {}

  async refreshFacts(rows: GiftFact[], source: string, now: string): Promise<{ changed: number }> {
    const stored = new Map<string, StoredFacts>();
    for (let i = 0; i < rows.length; i += READ_CHUNK) {
      const ids = rows.slice(i, i + READ_CHUNK).map((g) => g.mondayItemId);
      const res = await this.db
        .prepare(
          `SELECT monday_item_id, owner_item_id, owner_board_id, amount_cents, gift_date, fiscal_year, status, gift_type,
             acting_for_item_id, term_start, sponsorship_event, in_kind_value_cents, archived_at, removed_at
           FROM gifts WHERE monday_item_id IN (${ids.map((_, n) => `?${n + 1}`).join(', ')})`,
        )
        .bind(...ids)
        .all<StoredFacts>();
      for (const r of res.results) stored.set(r.monday_item_id, r);
    }
    const changed = rows.filter((g) => factsDiffer(stored.get(g.mondayItemId), g));

    for (let i = 0; i < changed.length; i += CHUNK) {
      const chunk = changed.slice(i, i + CHUNK);
      await this.db.batch(chunk.map((g) => this.db
        .prepare(
          `INSERT INTO gifts (monday_item_id, owner_item_id, owner_board_id, amount_cents,
             gift_date, fiscal_year, status, gift_type, acting_for_item_id, term_start, sponsorship_event, in_kind_value_cents, source, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?13, ?14, ?15, ?10, ?11)
           ON CONFLICT (monday_item_id) DO UPDATE SET
             owner_item_id = excluded.owner_item_id,
             owner_board_id = excluded.owner_board_id,
             amount_cents = excluded.amount_cents,
             gift_date = excluded.gift_date,
             fiscal_year = excluded.fiscal_year,
             status = excluded.status,
             gift_type = COALESCE(excluded.gift_type, gifts.gift_type),
             term_start = COALESCE(excluded.term_start, gifts.term_start),
             sponsorship_event = COALESCE(excluded.sponsorship_event, gifts.sponsorship_event),
             in_kind_value_cents = COALESCE(excluded.in_kind_value_cents, gifts.in_kind_value_cents),
             -- ?12 = 1 when the caller supplied acting_for (even null). Active gifts take the new value verbatim (staff may clear it); archived gifts always keep D1's — an archived item's board_relation reads back empty on Monday, and nothing else may rewrite history.
             acting_for_item_id = CASE
               WHEN ?12 = 0 THEN gifts.acting_for_item_id
               WHEN gifts.archived_at IS NOT NULL THEN gifts.acting_for_item_id
               ELSE excluded.acting_for_item_id END,
             -- Re-asserted by a recompute that just read it on Monday: no longer removed.
             removed_at = NULL,
             source = excluded.source,
             updated_at = excluded.updated_at`,
        )
        .bind(g.mondayItemId, g.ownerItemId, g.ownerBoardId, g.amountCents,
          g.giftDateISO, g.fiscalYear, g.status, g.giftType ?? null,
          g.actingForItemId ?? null, source, now, g.actingForItemId === undefined ? 0 : 1, g.termStart ?? null, g.sponsorshipEvent ?? null, g.inKindValueCents ?? null)));
    }
    return { changed: changed.length };
  }

  async giftsForOwner(ownerItemId: string): Promise<import('../projections/giftHistory').GiftHistoryRow[]> {
    // donation_links supplies the board id the deep link needs — gifts deliberately doesn't
    // duplicate it. LEFT JOIN so a link-less row still renders (without a link).
    const res = await this.db
      .prepare(`SELECT g.monday_item_id, l.donation_board_id, g.amount_cents, g.gift_date,
                       g.fiscal_year, g.status, g.gift_type, g.acting_for_item_id, g.term_start, g.sponsorship_event, g.in_kind_value_cents, g.archived_at
                FROM gifts g LEFT JOIN donation_links l ON l.donation_item_id = g.monday_item_id
                WHERE g.owner_item_id = ?1 AND g.removed_at IS NULL`)
      .bind(ownerItemId)
      .all<{ monday_item_id: string; donation_board_id: string | null; amount_cents: number;
        gift_date: string; fiscal_year: number; status: string; gift_type: string | null;
        acting_for_item_id: string | null; term_start: string | null; sponsorship_event: string | null;
        in_kind_value_cents: number | null; archived_at: string | null }>();
    return res.results.map((r) => ({
      mondayItemId: r.monday_item_id, donationBoardId: r.donation_board_id,
      amountCents: r.amount_cents, giftDateISO: r.gift_date, fiscalYear: r.fiscal_year,
      status: r.status, giftType: r.gift_type, actingForItemId: r.acting_for_item_id,
      termStart: r.term_start, sponsorshipEvent: r.sponsorship_event, inKindValueCents: r.in_kind_value_cents,
      archived: r.archived_at !== null,
    }));
  }

  async markRemoved(mondayItemId: string, now: string): Promise<{ ownerItemId: string; ownerBoardId: string; actingForItemId: string | null } | null> {
    const row = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id, acting_for_item_id, removed_at FROM gifts WHERE monday_item_id = ?1`)
      .bind(mondayItemId)
      .first<{ owner_item_id: string; owner_board_id: string; acting_for_item_id: string | null; removed_at: string | null }>();
    if (row === null) return null;
    if (row.removed_at === null) {
      await this.db
        .prepare(`UPDATE gifts SET removed_at = ?2, updated_at = ?2 WHERE monday_item_id = ?1`)
        .bind(mondayItemId, now)
        .run();
    }
    return { ownerItemId: row.owner_item_id, ownerBoardId: row.owner_board_id, actingForItemId: row.acting_for_item_id };
  }

  async giftsMissingTermStart(beforeISO: string, afterItemId: string, limit: number): Promise<string[]> {
    const res = await this.db
      .prepare(`SELECT monday_item_id FROM gifts
                WHERE term_start IS NULL AND removed_at IS NULL AND gift_date < ?1 AND monday_item_id > ?2
                ORDER BY monday_item_id LIMIT ?3`)
      .bind(beforeISO, afterItemId, limit)
      .all<{ monday_item_id: string }>();
    return res.results.map((r) => r.monday_item_id);
  }

  async setTermStarts(rows: { mondayItemId: string; termStart: string }[], now: string): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.db.batch(chunk.map((r) => this.db
        .prepare(`UPDATE gifts SET term_start = ?2, updated_at = ?3 WHERE monday_item_id = ?1`)
        .bind(r.mondayItemId, r.termStart, now)));
    }
  }

  async giftsMissingSponsorshipFacts(giftTypes: string[], afterItemId: string, limit: number): Promise<string[]> {
    if (giftTypes.length === 0) return [];
    // ?1 = cursor, ?2 = limit, types from ?3 (D1 caps bound parameters at 100).
    const res = await this.db
      .prepare(`SELECT monday_item_id FROM gifts
                WHERE (sponsorship_event IS NULL OR in_kind_value_cents IS NULL) AND removed_at IS NULL
                  AND gift_type IN (${giftTypes.map((_, n) => `?${n + 3}`).join(', ')}) AND monday_item_id > ?1
                ORDER BY monday_item_id LIMIT ?2`)
      .bind(afterItemId, limit, ...giftTypes)
      .all<{ monday_item_id: string }>();
    return res.results.map((r) => r.monday_item_id);
  }

  async setSponsorshipFacts(rows: { mondayItemId: string; sponsorshipEvent: string; inKindValueCents: number }[], now: string): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      await this.db.batch(chunk.map((r) => this.db
        .prepare(`UPDATE gifts SET sponsorship_event = COALESCE(sponsorship_event, ?2), in_kind_value_cents = COALESCE(in_kind_value_cents, ?3), updated_at = ?4 WHERE monday_item_id = ?1`)
        .bind(r.mondayItemId, r.sponsorshipEvent, r.inKindValueCents, now)));
    }
  }

  async ownersOnBoards(boardIds: string[]): Promise<{ ownerItemId: string; ownerBoardId: string }[]> {
    const out: { ownerItemId: string; ownerBoardId: string }[] = [];
    for (let i = 0; i < boardIds.length; i += READ_CHUNK) {
      const ids = boardIds.slice(i, i + READ_CHUNK);
      const res = await this.db
        .prepare(`SELECT DISTINCT owner_item_id, owner_board_id FROM gifts
                  WHERE removed_at IS NULL AND owner_board_id IN (${ids.map((_, n) => `?${n + 1}`).join(', ')})`)
        .bind(...ids)
        .all<{ owner_item_id: string; owner_board_id: string }>();
      for (const r of res.results) out.push({ ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id });
    }
    return out;
  }

  async actingForByIds(mondayItemIds: string[]): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    for (let i = 0; i < mondayItemIds.length; i += CHUNK) {
      const chunk = mondayItemIds.slice(i, i + CHUNK);
      const res = await this.db
        .prepare(`SELECT monday_item_id, acting_for_item_id FROM gifts
                  WHERE monday_item_id IN (${chunk.map((_, j) => `?${j + 1}`).join(',')})`)
        .bind(...chunk)
        .all<{ monday_item_id: string; acting_for_item_id: string | null }>();
      for (const r of res.results) out.set(r.monday_item_id, r.acting_for_item_id);
    }
    return out;
  }

  async attributedTotals(affiliationItemId: string, statusLabel: string): Promise<{ cents: number; count: number; lastGiftDateISO: string | null }> {
    const r = await this.db
      .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n, MAX(gift_date) AS last
                FROM gifts WHERE acting_for_item_id = ?1 AND status = ?2 AND removed_at IS NULL`)
      .bind(affiliationItemId, statusLabel)
      .first<{ cents: number; n: number; last: string | null }>();
    return { cents: r?.cents ?? 0, count: r?.n ?? 0, lastGiftDateISO: r?.last || null };
  }

  async organizationalGivingTotals(personItemId: string, statusLabel: string): Promise<{ cents: number; count: number }> {
    const r = await this.db
      .prepare(`SELECT COALESCE(SUM(g.amount_cents), 0) AS cents, COUNT(*) AS n
                FROM gifts g JOIN affiliations a ON a.affiliation_item_id = g.acting_for_item_id
                WHERE a.person_item_id = ?1 AND g.status = ?2 AND g.removed_at IS NULL`)
      .bind(personItemId, statusLabel)
      .first<{ cents: number; n: number }>();
    return { cents: r?.cents ?? 0, count: r?.n ?? 0 };
  }

  // Review finding 2: built FROM affiliations (LEFT JOIN gifts), not from gifts — so an
  // affiliation whose ledger total dropped to 0 (its gifts moved off it, or it never had
  // any) still appears with a zero, and reconcile leg 5 catches a stale non-zero column on
  // Monday instead of silently skipping it. A gift whose acting_for_item_id isn't in
  // affiliations (a bootstrap gap, not a ledger fact — see checkArtifactGuards) is excluded
  // by construction; it was never reachable from an affiliation row to begin with.
  async attributedTotalsAll(statusLabel: string): Promise<Map<string, { cents: number; count: number }>> {
    const res = await this.db
      .prepare(`SELECT a.affiliation_item_id,
                       COALESCE(SUM(CASE WHEN g.status = ?1 THEN g.amount_cents END), 0) AS cents,
                       COUNT(CASE WHEN g.status = ?1 THEN 1 END) AS n
                FROM affiliations a LEFT JOIN gifts g
                  ON g.acting_for_item_id = a.affiliation_item_id AND g.removed_at IS NULL
                GROUP BY a.affiliation_item_id`)
      .bind(statusLabel)
      .all<{ affiliation_item_id: string; cents: number; n: number }>();
    const out = new Map<string, { cents: number; count: number }>();
    for (const r of res.results) out.set(r.affiliation_item_id, { cents: r.cents, count: r.n });
    return out;
  }

  // Same reasoning as attributedTotalsAll, grouped by person instead: a person whose
  // affiliation(s) currently have no attributed gifts still appears with cents: 0, so
  // reconcile leg 6 catches a stale non-zero Organizational Giving column. Grouped by person
  // alone, like organizationalGivingTotals: a person who moved boards can have affiliation rows
  // naming each, and the board D1 holds is only a hint (see runReconcile), so MAX just picks one.
  async organizationalGivingAll(statusLabel: string): Promise<Map<string, { cents: number; personBoardId: string }>> {
    const res = await this.db
      .prepare(`SELECT a.person_item_id, MAX(a.person_board_id) AS person_board_id,
                       COALESCE(SUM(CASE WHEN g.status = ?1 THEN g.amount_cents END), 0) AS cents
                FROM affiliations a LEFT JOIN gifts g
                  ON g.acting_for_item_id = a.affiliation_item_id AND g.removed_at IS NULL
                GROUP BY a.person_item_id`)
      .bind(statusLabel)
      .all<{ person_item_id: string; person_board_id: string; cents: number }>();
    const out = new Map<string, { cents: number; personBoardId: string }>();
    for (const r of res.results) out.set(r.person_item_id, { cents: r.cents, personBoardId: r.person_board_id });
    return out;
  }

  async setSummaryItemId(fiscalYear: number, mondayItemId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE annual_summaries SET monday_item_id = ?2 WHERE fiscal_year = ?1`)
      .bind(fiscalYear, mondayItemId)
      .run();
  }

  async getArchivable(cutoffFY: number): Promise<{ mondayItemId: string; fiscalYear: number }[]> {
    const res = await this.db
      .prepare(`SELECT monday_item_id, fiscal_year FROM gifts
                WHERE archived_at IS NULL AND removed_at IS NULL AND fiscal_year < ?1
                ORDER BY fiscal_year, monday_item_id`)
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

  async countedGifts(fromFY: number, alsoIds: string[] = []): Promise<{ mondayItemId: string; ownerItemId: string; fiscalYear: number;
    amountCents: number; status: string; giftType: string | null }[]> {
    type Row = { monday_item_id: string; owner_item_id: string; fiscal_year: number; amount_cents: number; status: string; gift_type: string | null };
    const cols = 'monday_item_id, owner_item_id, fiscal_year, amount_cents, status, gift_type';
    const res = await this.db
      .prepare(`SELECT ${cols} FROM gifts WHERE removed_at IS NULL AND fiscal_year >= ?1 ORDER BY monday_item_id`)
      .bind(fromFY)
      .all<Row>();
    const rows = res.results;
    // Earlier-year extras only: a later one is already in the read above.
    for (let i = 0; i < alsoIds.length; i += READ_CHUNK) {
      const ids = alsoIds.slice(i, i + READ_CHUNK);
      const extra = await this.db
        .prepare(`SELECT ${cols} FROM gifts WHERE removed_at IS NULL AND fiscal_year < ?1
                  AND monday_item_id IN (${ids.map((_, n) => `?${n + 2}`).join(', ')})`)
        .bind(fromFY, ...ids)
        .all<Row>();
      rows.push(...extra.results);
    }
    return rows.map((r) => ({ mondayItemId: r.monday_item_id, ownerItemId: r.owner_item_id,
      fiscalYear: r.fiscal_year, amountCents: r.amount_cents, status: r.status, giftType: r.gift_type }));
  }

  async ownersWithOneGift(afterOwnerId = '', limit = 100_000, only?: OwnerFilter): Promise<{ ownerItemId: string; ownerBoardId: string; mondayItemId: string; donationBoardId: string }[]> {
    // donation_links carries the donation board id the queue message needs; gifts alone
    // doesn't. MIN() picks an arbitrary-but-stable representative gift per owner. Ordered +
    // cursored so the July sweep can slice itself under the Worker subrequest budget.
    // `only` narrows to owners on one board with at least one live gift of the given types (the
    // January sweep, which only rolls the Sponsorships window: issue #88).
    const filter = only === undefined ? '' : `AND owner_board_id = ?3 AND owner_item_id IN (
                  SELECT owner_item_id FROM gifts WHERE removed_at IS NULL AND gift_type IN (${only.giftTypes.map((_, n) => `?${n + 4}`).join(', ')}))`;
    const res = await this.db
      .prepare(`SELECT owner_item_id, MIN(owner_board_id) AS owner_board_id, MIN(donation_item_id) AS donation_item_id,
                       MIN(donation_board_id) AS donation_board_id
                FROM donation_links WHERE owner_item_id > ?1 ${filter}
                GROUP BY owner_item_id ORDER BY owner_item_id LIMIT ?2`)
      .bind(...(only === undefined ? [afterOwnerId, limit] : [afterOwnerId, limit, only.ownerBoardId, ...only.giftTypes]))
      .all<{ owner_item_id: string; owner_board_id: string; donation_item_id: string; donation_board_id: string }>();
    return res.results.map((r) => ({
      ownerItemId: r.owner_item_id, ownerBoardId: r.owner_board_id, mondayItemId: r.donation_item_id, donationBoardId: r.donation_board_id,
    }));
  }

  async ownerTotals(statusLabel: string): Promise<Map<string, { cents: number; count: number; ownerBoardId: string }>> {
    const res = await this.db
      .prepare(`SELECT owner_item_id, owner_board_id, SUM(amount_cents) AS cents, COUNT(*) AS n
                FROM gifts WHERE status = ?1 AND removed_at IS NULL GROUP BY owner_item_id, owner_board_id`)
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
                FROM gifts WHERE status = ?1 AND fiscal_year < ?2 AND removed_at IS NULL
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
