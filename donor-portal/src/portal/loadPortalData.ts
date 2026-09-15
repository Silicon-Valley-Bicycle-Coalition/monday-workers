import type { MondayClient } from '../monday/client';
import type { DonorVolunteerHistory, PortalView, VolunteerShift } from '../types';
import { parseAmount } from '../letters/loadLetterData';

export interface VolunteerHistoryOptions {
  enabled: boolean;
  completedStatuses: string[];
}

// Pure so the status-filter/sort/sum rules are testable without a Monday fake. An empty
// completedStatuses list means "include every status" (see VolunteerHistoryConfig in types.ts).
export function buildVolunteerHistory(shifts: VolunteerShift[], completedStatuses: string[]): DonorVolunteerHistory {
  const included = completedStatuses.length > 0 ? shifts.filter((s) => completedStatuses.includes(s.status)) : shifts;
  // Most recent first; Monday date column text is YYYY-MM-DD so string comparison orders
  // correctly, and shifts with no date sort last.
  const sorted = [...included].sort((a, b) => b.date.localeCompare(a.date));
  // parseAmount (shared with the letters path) rather than parseFloat, so formatted number
  // text ("1,250") sums to what the table row displays instead of truncating at the comma.
  const rawTotal = included.reduce((sum, s) => sum + parseAmount(s.hours), 0);
  // Round to 2 decimals so summed fractional shifts (2.1 + 0.2, …) don't render float noise.
  const totalHours = Math.round(rawTotal * 100) / 100;
  return { shifts: sorted, totalHours };
}

export async function loadPortalData(
  donorItemIds: string[],
  monday: MondayClient,
  volunteerOptions?: VolunteerHistoryOptions,
  // routes.ts passes donationHistoryEnabled(config, now). Defaults to true so callers that
  // predate the gate keep the always-on behavior.
  donationHistoryEnabled = true
): Promise<PortalView> {
  // The volunteer read degrades instead of failing the page: a Volunteers-board error (the
  // integration user not yet granted access, a Monday 429, an unverified query shape) should
  // cost the donor the volunteer section, not their donations/membership/discounts.
  const volunteerLeg: Promise<VolunteerShift[][] | null> = volunteerOptions?.enabled
    ? Promise.all(donorItemIds.map((id) => monday.getVolunteerShiftsForDonor(id))).catch((err) => {
        console.error(`donor-portal volunteer history load failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
    : Promise.resolve(null);

  const [donors, discounts, shiftsPerDonor] = await Promise.all([
    Promise.all(donorItemIds.map((id) => monday.getDonorPortalData(id, { includeDonations: donationHistoryEnabled }))),
    monday.getDiscountOrganizations(),
    volunteerLeg,
  ]);

  const completedStatuses = volunteerOptions?.completedStatuses ?? [];
  // Keyed by the donor ids Monday echoed back (donors is index-aligned with donorItemIds), so
  // the views' lookup by donor.id can never miss on an id-formatting mismatch.
  const volunteerHistory =
    shiftsPerDonor === null
      ? null
      : Object.fromEntries(donors.map((donor, index) => [donor.id, buildVolunteerHistory(shiftsPerDonor[index] ?? [], completedStatuses)]));

  return { donors, discounts, volunteerHistory, donationHistoryEnabled };
}
