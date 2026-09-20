import type { MondayClient } from '../monday/client';
import type { PledgeRecord } from '../types';
import { parseAmount } from '../amounts';

export interface PledgeWithProgress extends PledgeRecord {
  // Whole-number percent of the pledge fulfilled, or null when either amount doesn't parse as
  // a positive number (the view renders a dash instead of a bogus 0%).
  percentComplete: number | null;
}

export interface DonorPledges {
  donorItemId: string;
  donorName: string;
  pledges: PledgeWithProgress[];
}

// Re-exported for callers/tests of this module; the actual parsing lives in ../amounts so
// letters and pledges share one implementation.
export { parseAmount };

export function computePercent(pledged: string, fulfilled: string): number | null {
  const pledgedNum = parseAmount(pledged);
  const fulfilledNum = parseAmount(fulfilled);
  if (pledgedNum === null || fulfilledNum === null || pledgedNum <= 0 || fulfilledNum < 0) return null;
  // Overpayment displays as 100%, not 120% — the page tracks "is this pledge done", and a
  // >100% figure reads like a data error to a donor.
  return Math.min(100, Math.round((fulfilledNum / pledgedNum) * 100));
}

export async function loadPledgeData(donorItemIds: string[], monday: MondayClient): Promise<DonorPledges[]> {
  // The name lookup and the per-donor pledge fetches are independent — run them concurrently
  // rather than paying an extra serial Monday round-trip on every page view.
  const [names, pledgesPerDonor] = await Promise.all([
    monday.getDonorNames(donorItemIds),
    Promise.all(donorItemIds.map((id) => monday.getPledgesForDonor(id))),
  ]);
  const nameById = new Map(names.map((n) => [n.id, n.name]));
  return donorItemIds.map((donorItemId, i) => ({
    donorItemId,
    // donorItemIds come from the session, so a missing name means the Monday item vanished
    // mid-session — fall back to the item id (a record identifier staff can look up) rather
    // than rendering a blank heading and broken copy, and never drop the donor's pledges
    // silently.
    donorName: nameById.get(donorItemId) ?? donorItemId,
    pledges: pledgesPerDonor[i]!.map((p) => ({ ...p, percentComplete: computePercent(p.pledged, p.fulfilled) })),
  }));
}
