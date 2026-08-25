import type { MondayClient } from '../monday/client';
import type { DonorVolunteerHistory, PortalView, VolunteerShift } from '../types';

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
  const rawTotal = included.reduce((sum, s) => sum + (Number.parseFloat(s.hours) || 0), 0);
  // Round to 2 decimals so summed fractional shifts (2.1 + 0.2, …) don't render float noise.
  const totalHours = Math.round(rawTotal * 100) / 100;
  return { shifts: sorted, totalHours };
}

export async function loadPortalData(
  donorItemIds: string[],
  monday: MondayClient,
  volunteerOptions?: VolunteerHistoryOptions
): Promise<PortalView> {
  const [donors, discounts, shiftsPerDonor] = await Promise.all([
    Promise.all(donorItemIds.map((id) => monday.getDonorPortalData(id))),
    monday.getDiscountOrganizations(),
    volunteerOptions?.enabled
      ? Promise.all(donorItemIds.map((id) => monday.getVolunteerShiftsForDonor(id)))
      : Promise.resolve(null),
  ]);

  const volunteerHistory =
    shiftsPerDonor === null
      ? null
      : Object.fromEntries(
          donorItemIds.map((id, index) => [
            id,
            buildVolunteerHistory(shiftsPerDonor[index]!, volunteerOptions!.completedStatuses),
          ])
        );

  return { donors, discounts, volunteerHistory };
}
