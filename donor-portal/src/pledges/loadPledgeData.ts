import type { MondayClient } from '../monday/client';
import type { PledgeRecord } from '../types';

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

// Monday amount columns arrive as display text ("$1,200.00", "1200", "US$1 200") — strip
// everything except digits, dot, and minus rather than assuming one currency format. Returns
// null for text with no digits at all, so "pending" or "" never silently becomes 0.
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[^0-9.-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

export function computePercent(pledged: string, fulfilled: string): number | null {
  const pledgedNum = parseAmount(pledged);
  const fulfilledNum = parseAmount(fulfilled);
  if (pledgedNum === null || fulfilledNum === null || pledgedNum <= 0 || fulfilledNum < 0) return null;
  // Overpayment displays as 100%, not 120% — the page tracks "is this pledge done", and a
  // >100% figure reads like a data error to a donor.
  return Math.min(100, Math.round((fulfilledNum / pledgedNum) * 100));
}

export async function loadPledgeData(donorItemIds: string[], monday: MondayClient): Promise<DonorPledges[]> {
  const names = await monday.getDonorNames(donorItemIds);
  const nameById = new Map(names.map((n) => [n.id, n.name]));
  return Promise.all(
    donorItemIds.map(async (donorItemId) => {
      const pledges = await monday.getPledgesForDonor(donorItemId);
      return {
        donorItemId,
        // Same session-shape guarantee as the rest of the portal: donorItemIds come from the
        // session, so a missing name means the Monday item vanished mid-session — render the
        // section with a blank name rather than dropping the donor's pledges silently.
        donorName: nameById.get(donorItemId) ?? '',
        pledges: pledges.map((p) => ({ ...p, percentComplete: computePercent(p.pledged, p.fulfilled) })),
      };
    })
  );
}
