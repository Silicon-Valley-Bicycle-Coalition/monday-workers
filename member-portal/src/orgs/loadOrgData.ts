import type { AppDeps } from '../routes';
import type { OrgGift } from '../monday/client';
import { orgAcknowledgmentEnabled, volunteerHistoryEnabled } from '../config';
import { errorText } from '../logSafe';
import { buildStatement, statementYears } from './statement';
import type { OrgStatement } from './statement';

type OrgDeps = Pick<AppDeps, 'monday' | 'config' | 'now'>;
type OrgInfo = { id: string; name: string; address: string };

// null when the id isn't an active item on the Organizations board (a People-board id, say).
export async function loadOrgPage(
  orgItemId: string,
  deps: OrgDeps
): Promise<{ org: OrgInfo; gifts: OrgGift[]; matches: OrgGift[]; years: number[] } | null> {
  const org = await deps.monday.getOrganization(orgItemId);
  if (org === null) return null;
  const [gifts, matches] = await Promise.all([
    deps.monday.getOrganizationGifts(orgItemId),
    deps.monday.getOrganizationMatches(orgItemId),
  ]);
  return { org, gifts, matches, years: statementYears(gifts, matches, deps.now()) };
}

// The employees' volunteer hours, or null when the feature is off or a read fails (the statement
// still renders without that block).
async function loadVolunteering(
  orgItemId: string,
  year: number,
  deps: OrgDeps
): Promise<{ hours: Map<string, number>; employeeIds: string[] } | null> {
  if (!volunteerHistoryEnabled(deps.config)) return null;
  try {
    const current = deps.config.changeRequests.employer?.currentStatusLabel;
    const [hours, affiliations] = await Promise.all([
      deps.monday.getCompletedVolunteerHoursInYear(year),
      deps.monday.getOrganizationAffiliations(orgItemId),
    ]);
    const employeeIds = affiliations
      .filter((a) => a.statusLabel === current && a.personItemId !== null)
      .map((a) => a.personItemId as string);
    return { hours, employeeIds };
  } catch (err) {
    console.error(`member-portal organization volunteering failed for "${orgItemId}": ${errorText(err)}`);
    return null;
  }
}

export async function loadOrgStatement(orgItemId: string, year: number, deps: OrgDeps): Promise<OrgStatement | null> {
  if (year >= deps.now().getUTCFullYear()) return null;
  const page = await loadOrgPage(orgItemId, deps);
  if (page === null) return null;
  const volunteering = await loadVolunteering(orgItemId, year, deps);
  return buildStatement({
    org: page.org,
    year,
    gifts: page.gifts,
    matches: page.matches,
    volunteerHoursByPerson: volunteering?.hours ?? null,
    employeeIds: volunteering?.employeeIds ?? [],
    taxLetter: deps.config.taxLetter,
    volunteerFloor: deps.config.organizations.volunteerFloor,
    acknowledgmentOn: orgAcknowledgmentEnabled(deps.config),
  });
}
