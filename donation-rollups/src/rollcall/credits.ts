// Keeps the roll_call_credits table (migration 0011) in step with the active Donations board: one
// row per counted gift that the Donors ledger can't credit by itself. The nightly rollcall duty
// diffs the table, not Monday, so a quiet night writes nothing. See the donor roll call design,
// spec §3, for the rules creditFor carries.
import type { CustodianDeps, CustodianMondayClient } from '../custodian/custodian';
import type { CreditRow } from '../db/rollCallCredits';
import type { RollCallConfig } from '../types';
import { RECEIVED_LABELS } from './compute';

export type DonationCreditItem = Awaited<ReturnType<CustodianMondayClient['pageDonationCredits']>>['items'][number];

const MATCHING = 'Matching Donation';

// 'skip' = not a counted gift; 'ledger' = counted, credited to its Donor by the Donors ledger
// (no row); otherwise the row's credit. A null credit is a matching gift with no Matched By
// company: the employee keeps it, and the row exists only to carry unmatchedMatch.
export function creditFor(
  item: DonationCreditItem, excludedGiftTypes: string[],
): { credit: string | null; unmatchedMatch: boolean } | 'ledger' | 'skip' {
  // Never on the amount: the credit (who is named, or not) comes from the flags alone, so a $0 or
  // unreadable Amount can't drop an Anonymous or Matched By gift's row and hand it back to its
  // Donor through the ledger. Whether the gift counts is rollCallGifts' call.
  if (!Number.isInteger(item.fiscalYear) || item.fiscalYear <= 0) return 'skip';
  if (item.status === null || !RECEIVED_LABELS.includes(item.status)) return 'skip';
  if (excludedGiftTypes.includes(item.giftType)) return 'skip';
  const matching = item.giftType === MATCHING;
  const matchedBy = item.matchedByItemIds[0];
  // A matching gift goes to its company even when the employee is anonymous.
  if (matching && matchedBy !== undefined) return { credit: `item:${matchedBy}`, unmatchedMatch: false };
  if (item.anonymous) return { credit: 'anonymous', unmatchedMatch: false };
  if (item.donorItemIds.length === 0) return { credit: 'unplaced', unmatchedMatch: false };
  if (matching) return { credit: null, unmatchedMatch: true };
  return 'ledger';
}

// currentFY bounds the years counted from above: a gift dated past it (a typo like 2062) is
// skipped rather than given a year group of its own.
export async function refreshCredits(
  deps: CustodianDeps, cfg: RollCallConfig, now: string, currentFY: number,
): Promise<{ upserted: number; removed: number; archived: number }> {
  const stored = new Map((await deps.rollCallCredits.all(cfg.firstFiscalYear)).map((r) => [r.giftItemId, r]));

  const seen = new Set<string>();
  const rows = new Map<string, CreditRow>(); // by gift id: a paging race can repeat an item
  const removals: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await deps.mondayClient.pageDonationCredits(cfg.donations, cursor, deps.config.fiscalYear.startMonth);
    for (const item of page.items) {
      seen.add(item.id);
      const verdict = item.fiscalYear < cfg.firstFiscalYear || item.fiscalYear > currentFY ? 'skip' : creditFor(item, cfg.excludedGiftTypes);
      if (typeof verdict === 'object') {
        // archivedAt null: an item restored from the archive clears its old stamp.
        // amount_cents is NOT NULL: a blank Amount is stored as 0, which counts for nothing either.
        rows.set(item.id, { giftItemId: item.id, fiscalYear: item.fiscalYear, amountCents: item.amountCents ?? 0,
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
  return { upserted, removed: removals.length + gone.length, archived: archived.length };
}
