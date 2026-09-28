import type { MondayClient } from '../monday/client';
import type { DiscountOrganization, DonorVolunteerHistory, MemberPortalData, PortalView, VolunteerShift } from '../types';
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
        console.error(`member-portal volunteer history load failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      })
    : Promise.resolve(null);

  // Same degrade-instead-of-fail rule for the shared discount list: an Organizations-board error
  // costs the donor the discounts section (null → omitted), not the dashboard.
  const discountLeg: Promise<DiscountOrganization[] | null> = monday.getDiscountOrganizations().catch((err) => {
    console.error(`member-portal discount organizations load failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });

  // Per donor, not all-or-nothing (issue #31): a household login spans several donor items, and
  // one bad record (a deleted item, a Monday error on that id) used to fail the whole dashboard.
  const [donorResults, discounts, shiftsPerDonor] = await Promise.all([
    Promise.allSettled(donorItemIds.map((id) => monday.getMemberPortalData(id, { includeDonations: donationHistoryEnabled }))),
    discountLeg,
    volunteerLeg,
  ]);

  const loaded: { donor: MemberPortalData; index: number }[] = [];
  donorResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      loaded.push({ donor: result.value, index });
    } else {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.error(`member-portal dashboard load failed for donor "${donorItemIds[index]}": ${reason}`);
    }
  });
  // Nothing to show at all — let the route's error page handle it, as before.
  if (loaded.length === 0 && donorResults.length > 0) {
    throw (donorResults[0] as PromiseRejectedResult).reason;
  }
  const donors = loaded.map((entry) => entry.donor);

  const completedStatuses = volunteerOptions?.completedStatuses ?? [];
  // Keyed by the donor ids Monday echoed back; shiftsPerDonor stays index-aligned with
  // donorItemIds, so look each loaded donor's shifts up by its original index.
  const volunteerHistory =
    shiftsPerDonor === null
      ? null
      : Object.fromEntries(
          loaded.map(({ donor, index }) => [donor.id, buildVolunteerHistory(shiftsPerDonor[index] ?? [], completedStatuses)])
        );

  return {
    donors,
    unavailableDonorCount: donorResults.length - loaded.length,
    discounts,
    volunteerHistory,
    donationHistoryEnabled,
  };
}
