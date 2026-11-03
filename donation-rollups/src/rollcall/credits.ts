// Keeps the roll_call_credits table (migration 0011) in step with the active Donations board: one
// row per counted gift that the Donors ledger can't credit by itself, and one per Anonymous or
// Matched By gift whether it counts or not (see creditFor). The nightly rollcall duty
// diffs the table, not Monday, so a quiet night writes nothing. See the donor roll call design,
// spec §3, for the rules creditFor carries.
import type { CustodianDeps, CustodianMondayClient } from '../custodian/custodian';
import type { CreditRow } from '../db/rollCallCredits';
import type { RollCallConfig } from '../types';
import { RECEIVED_LABELS } from './compute';

export type DonationCreditItem = Awaited<ReturnType<CustodianMondayClient['pageDonationCredits']>>['items'][number];

const MATCHING = 'Matching Donation';

// A Recognition Fiscal Year cell (spec §10.1): '2026' or 'FY2026', any case and spacing. null =
// blank, or the gift's own year (no override); 'invalid' = typed but unreadable, so the gift
// stays in its own year and the run reports it.
export function recognitionYear(text: string, ownYear: number): number | null | 'invalid' {
  const t = text.replace(/\s+/g, '');
  if (t === '') return null;
  const m = /^(?:FY)?(\d{4})$/i.exec(t);
  if (m === null) return 'invalid';
  const year = Number(m[1]);
  return year === ownYear ? null : year;
}

// The cents a gift counts for: its Amount, or its In-Kind Value when Amount is blank or zero, as
// the old script did (spec §10.3). null when neither reads.
export function countedCents(item: Pick<DonationCreditItem, 'amountCents' | 'inKindValueCents'>): number | null {
  if (item.amountCents !== null && item.amountCents > 0) return item.amountCents;
  if (item.inKindValueCents !== null && item.inKindValueCents > 0) return item.inKindValueCents;
  return item.amountCents;
}

// 'skip' = not a counted gift; 'ledger' = counted, credited to its Donor by the Donors ledger
// (no row); otherwise the row's credit. A null credit is a matching gift with no Matched By
// company: the employee keeps it, and the row exists only to carry unmatchedMatch.
export function creditFor(
  item: DonationCreditItem, excludedGiftTypes: string[], years: { first: number; current: number },
): { credit: string | null; unmatchedMatch: boolean } | 'ledger' | 'skip' {
  // A credit that names someone else (Matched By, Anonymous) comes from the flags alone, before
  // anything that decides whether the gift counts: not the amount, year, status or gift type.
  // The ledger keeps its own copy of those facts, which can lag the board or, for a gift whose
  // Date was cleared, never refresh at all, so it may still count a gift this read would skip.
  // Dropping the row there would hand the gift back to its Donor by name. rollCallGifts' counted()
  // decides whether it counts, from whichever copy it has.
  const matching = item.giftType === MATCHING;
  const matchedBy = item.matchedByItemIds[0];
  // A matching gift goes to its company even when the employee is anonymous.
  if (matching && matchedBy !== undefined) return { credit: `item:${matchedBy}`, unmatchedMatch: false };
  if (item.anonymous) return { credit: 'anonymous', unmatchedMatch: false };
  // A Recognition Fiscal Year or an in-kind amount is a fact the ledger doesn't hold, so it rides
  // on a credit-null row (the ledger still names the Donor) from the cells alone, like the flags
  // above: without the row the ledger would count the gift in its own year, or at $0.
  const recognized = recognitionYear(item.recognitionFiscalYear, item.fiscalYear);
  const override = typeof recognized === 'number' ? recognized : null;
  const inKind = countedCents(item) !== item.amountCents;
  if ((override !== null || inKind) && item.donorItemIds.length > 0) return { credit: null, unmatchedMatch: item.giftType === MATCHING };
  // years.current bounds the years counted from above: a gift dated past it (a typo like 2062)
  // is skipped rather than given a year group of its own. An override to a future year waits too.
  const year = override ?? item.fiscalYear;
  if (!Number.isInteger(year) || year < years.first || year > years.current) return 'skip';
  if (item.status === null || !RECEIVED_LABELS.includes(item.status)) return 'skip';
  if (excludedGiftTypes.includes(item.giftType)) return 'skip';
  if (item.donorItemIds.length === 0) return { credit: 'unplaced', unmatchedMatch: false };
  if (matching) return { credit: null, unmatchedMatch: true };
  return 'ledger';
}

export async function refreshCredits(
  deps: CustodianDeps, cfg: RollCallConfig, now: string, currentFY: number,
): Promise<{ upserted: number; removed: number; archived: number; badRecognitionYears?: string[] }> {
  const stored = new Map((await deps.rollCallCredits.all()).map((r) => [r.giftItemId, r]));

  const seen = new Set<string>();
  const rows = new Map<string, CreditRow>(); // by gift id: a paging race can repeat an item
  const removals: string[] = [];
  const badRecognitionYears = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await deps.mondayClient.pageDonationCredits(cfg.donations, cursor, deps.config.fiscalYear.startMonth);
    for (const item of page.items) {
      seen.add(item.id);
      const recognized = recognitionYear(item.recognitionFiscalYear, item.fiscalYear);
      if (recognized === 'invalid') badRecognitionYears.add(item.id);
      const verdict = creditFor(item, cfg.excludedGiftTypes, { first: cfg.firstFiscalYear, current: currentFY });
      if (typeof verdict === 'object') {
        // archivedAt null: an item restored from the archive clears its old stamp.
        // amount_cents is NOT NULL: a blank Amount (with no In-Kind Value) is stored as 0, which
        // counts for nothing either; so is an unreadable fiscal year, which counted() never counts.
        rows.set(item.id, { giftItemId: item.id, fiscalYear: Number.isInteger(item.fiscalYear) ? item.fiscalYear : 0,
          recognitionFiscalYear: typeof recognized === 'number' ? recognized : null, amountCents: countedCents(item) ?? 0,
          status: item.status ?? '', giftType: item.giftType, credit: verdict.credit,
          unmatchedMatch: verdict.unmatchedMatch, archivedAt: null });
      } else if (stored.has(item.id)) {
        removals.push(item.id);
      }
    }
    cursor = page.cursor;
  } while (cursor !== null);

  // Rows with archived_at already set are never re-checked; an unseen live row is either archived
  // or deleted since the last run — or a paging race moved it, in which case it stays for now.
  const unseen = [...stored.values()].filter((r) => r.archivedAt === null && !seen.has(r.giftItemId)).map((r) => r.giftItemId);
  // An empty board with live rows stored is a failed read far more often than every gift going
  // at once; resolving them all through getItemsState would drop the lot. Refuse instead.
  if (seen.size === 0 && unseen.length > 0) {
    throw new Error(`rollcall: Donations board ${cfg.donations.boardId} read back no items, but ${unseen.length} stored credits rows are live — refusing to refresh`);
  }
  const states = unseen.length > 0 ? await deps.mondayClient.getItemsState(unseen) : new Map<string, string>();
  const gone = unseen.filter((id) => (states.get(id) ?? 'deleted') === 'deleted');
  const archived = unseen.filter((id) => states.get(id) === 'archived');

  const upserted = await deps.rollCallCredits.upsert([...rows.values()], now);
  if (removals.length + gone.length > 0) await deps.rollCallCredits.remove([...removals, ...gone]);
  if (archived.length > 0) await deps.rollCallCredits.markArchived(archived, now);
  return { upserted, removed: removals.length + gone.length, archived: archived.length,
    ...(badRecognitionYears.size > 0 ? { badRecognitionYears: [...badRecognitionYears] } : {}) };
}
