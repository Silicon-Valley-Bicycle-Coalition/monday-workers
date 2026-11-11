import type { DtdSyncConfig } from '../config';
import type { DtdMondayClient } from '../monday/client';
import { companyForItem } from '../db/records';
import { MATCHING_GIFT_TYPE, monthsBefore, pairMatch } from '../pairing/pair';
import { logItemFailure } from '../logSafe';
import { getReviewSweep, setReviewSweep } from '../db/state';

export interface PairingDeps { monday: DtdMondayClient; db: D1Database; config: DtdSyncConfig }

const STAFF = 'Staff';
const NEEDS_REVIEW = 'Needs review';
const MATCHED = 'Matched';
// Matches already in Needs review are re-evaluated (a candidate gift or a company name may have
// turned up) at most this often; new matches are evaluated every run.
const REVIEW_SWEEP_INTERVAL_MS = 24 * 3_600_000;

/**
 * Link each unpaired employer match to the donor's gift it matched. Every run re-evaluates the open
 * matches, except that matches already in Needs review wait for a daily sweep; Monday is written only on a change. A `Staff` pairing is never touched.
 *
 * Then, for every Matching Donation already linked to a gift (any pairing, Staff included), make sure
 * that gift's Match Status is `Matched`: this covers staff links and heals a Matched write that failed
 * after its link was written.
 */
export async function runPairing(deps: PairingDeps, now: Date): Promise<{ linked: number; review: number }> {
  const { monday, db, config } = deps;
  const d = config.donations;
  const since = monthsBefore(now.toISOString(), config.pairing.windowMonths);
  const matches = await monday.listDonationsOfTypeDatedSince(MATCHING_GIFT_TYPE, since);
  const unlinked = matches.filter((i) => i.matchesGiftItemId === null && i.matchPairing !== STAFF);
  const lastSweep = await getReviewSweep(db);
  const sweepDue = lastSweep === null || now.getTime() - new Date(lastSweep).getTime() >= REVIEW_SWEEP_INTERVAL_MS;
  const open = unlinked.filter((i) => sweepDue || i.matchPairing !== NEEDS_REVIEW);

  let linked = 0;
  const pairedGiftIds: string[] = [];
  let review = 0;
  for (const match of open) {
    try {
      let candidates: Awaited<ReturnType<DtdMondayClient['listGiftsForDonor']>> = [];
      if (match.donorItemId !== null && match.date !== null) {
        candidates = await monday.listGiftsForDonor(match.donorItemId, monthsBefore(match.date, config.pairing.windowMonths));
      }
      candidates = candidates.filter((c) => c.id !== match.id && c.giftType !== MATCHING_GIFT_TYPE && c.date !== null && c.date <= match.date!);

      const companyName = match.matchedByItemId === null ? null : await monday.getOrganizationName(match.matchedByItemId);
      const companies = new Map<string, string | null>();
      if (companyName !== null) for (const c of candidates) companies.set(c.id, await companyForItem(db, c.id));

      const result = pairMatch(match, companyName, candidates, (id) => companies.get(id) ?? null, config.pairing);
      if (result.kind === 'review') {
        review++;
        if (match.matchPairing !== NEEDS_REVIEW) await monday.updateDonation(match.id, { [d.matchPairing]: { label: NEEDS_REVIEW } });
        continue;
      }
      await monday.updateDonation(match.id, {
        [d.matchesGift]: { item_ids: [Number(result.giftItemId)] },
        [d.matchPairing]: { label: 'Auto' },
      });
      await monday.updateDonation(result.giftItemId, { [d.matchStatus]: { label: MATCHED } });
      linked++;
      pairedGiftIds.push(result.giftItemId);
    } catch (err) {
      logItemFailure('pairing', match.id, err);
    }
  }

  // Gifts linked by a Matching Donation, read 100 to a call. Skip matches this run just paired: it
  // already wrote Matched for them.
  let healed = 0;
  const justPaired = new Set(pairedGiftIds);
  const linkedGiftIds = matches.flatMap((m) => (m.matchesGiftItemId === null || justPaired.has(m.matchesGiftItemId) ? [] : [m.matchesGiftItemId]));
  try {
    for (const gift of await monday.getDonations(linkedGiftIds)) { // a gone gift, or one not on Donations, is absent
      if (gift.matchStatus === MATCHED) continue;
      try {
        await monday.updateDonation(gift.id, { [d.matchStatus]: { label: MATCHED } });
        healed++;
      } catch (err) {
        logItemFailure('pairing', gift.id, err);
      }
    }
  } catch (err) {
    logItemFailure('pairing', 'heal', err);
  }
  if (sweepDue) await setReviewSweep(db, now.toISOString());
  console.log(JSON.stringify({ job: 'pairing', considered: open.length, linked, review, healed }));
  return { linked, review };
}
