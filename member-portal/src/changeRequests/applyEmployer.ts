import type { ChangeRequestRow } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';
import type { Config } from '../types';
import { planAffiliationChange, previousPrimaryNote } from './employer';
import { organizationNameVariants, pickOrganization } from './employerName';

// Staff-facing Field values on the Change Requests log item (English, like FIELD_LABELS).
export const EMPLOYER_LABELS = {
  applied: 'Employer (applied)',
  noChange: 'Employer (no change)',
  needsOrganization: 'Employer (needs an Organization)',
  needsStaff: 'Employer (needs staff review)',
} as const;

// A donor's employer answer, applied by the writer (spec 2026-11-16-donor-employer-answer-design.md).
// One exact (normalised) Organization match moves Primary onto that person's affiliation; anything
// else goes to staff. Returns what the Change Requests log item should say. Every step re-reads
// Monday first, so a retry after a partial run finishes the job instead of repeating it.
export async function applyEmployerAnswer(
  row: ChangeRequestRow,
  deps: { monday: MondayClient; config: Config },
): Promise<{ fieldLabel: string; newValue: string }> {
  const employer = deps.config.changeRequests.employer ?? null;
  if (employer === null) throw new Error('config: changeRequests.employer is not configured');
  const organizationsBoardId = deps.config.monday.organizationsBoardId;
  if (organizationsBoardId === null) throw new Error('config: monday.organizationsBoardId is not configured');

  const names = organizationNameVariants(row.newValue);
  const candidates =
    names.length === 0 ? [] : await deps.monday.findOrganizationsByNames({ boardId: organizationsBoardId, names });
  const pick = pickOrganization(row.newValue, candidates);
  if (pick.kind === 'none') return { fieldLabel: EMPLOYER_LABELS.needsOrganization, newValue: row.newValue };
  if (pick.kind === 'several') {
    const list = pick.organizations.map((o) => o.name).join(', ');
    return {
      fieldLabel: EMPLOYER_LABELS.needsOrganization,
      newValue: `"${row.newValue}" — ${pick.organizations.length} Organizations match: ${list}`,
    };
  }

  const organization = pick.organization;
  const affiliations = await deps.monday.getPersonAffiliations({ donorItemId: row.donorItemId, employer });
  const plan = planAffiliationChange(affiliations, organization.id, employer.currentStatusLabel);
  if (plan.kind === 'noChange') return { fieldLabel: EMPLOYER_LABELS.noChange, newValue: organization.name };
  if (plan.kind === 'needsStaff') {
    return {
      fieldLabel: EMPLOYER_LABELS.needsStaff,
      newValue: `${organization.name} — their affiliation is ${plan.affiliation.statusLabel ?? 'without a Status'} with Portal access ticked, so it was not made Current. Untick Portal access or set Status by hand.`,
    };
  }

  // The matched affiliation first: a crash before the clears leaves two Primaries for a moment,
  // never none, and the retry clears the old one.
  if (plan.reuseAffiliationId === null) {
    await deps.monday.createAffiliation({
      employer,
      itemName: `${row.donorName} — ${organization.name}`,
      donorItemId: row.donorItemId,
      organizationItemId: organization.id,
    });
  } else {
    await deps.monday.updateAffiliation({ employer, itemId: plan.reuseAffiliationId, makeCurrent: true, primary: true });
  }
  for (const other of plan.clearPrimaryOn) {
    await deps.monday.updateAffiliation({ employer, itemId: other.id, makeCurrent: false, primary: false });
  }
  return { fieldLabel: EMPLOYER_LABELS.applied, newValue: `${organization.name}${previousPrimaryNote(plan.clearPrimaryOn)}` };
}
