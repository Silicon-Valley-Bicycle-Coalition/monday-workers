// Pure rules for a donor's own employer answer (spec 2026-11-16-donor-employer-answer-design.md):
// which Organization a typed name means (employerName.ts), and which affiliation writes make it
// the donor's Current, Primary one. No I/O here; applyEmployer.ts does the Monday calls.

export interface AffiliationRecord {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
  statusLabel: string | null;
  primary: boolean;
  // The Affiliations "Portal access" checkbox; false when that column is unconfigured.
  portalAccess: boolean;
}

export type AffiliationPlan =
  | { kind: 'noChange' }
  | { kind: 'needsStaff'; affiliation: AffiliationRecord }
  | { kind: 'apply'; reuseAffiliationId: string | null; clearPrimaryOn: AffiliationRecord[] };

// Primary moves to the matched Organization's affiliation (reused if one exists: Current and
// Primary first, then Current, then any without Portal access). Every other Primary — including a
// duplicate to the same Organization — loses only Primary: Status on another affiliation never
// changes.
//
// Reusing an affiliation makes it Current, and Current plus Portal access is what lets a person act
// for the organization (orgs/grants.ts). So an affiliation staff ended while leaving Portal access
// ticked is never reused: the donor's own answer would hand them back the organization's gifts and
// statements. That case goes to staff.
export function planAffiliationChange(
  affiliations: AffiliationRecord[],
  organizationId: string,
  currentStatusLabel: string,
): AffiliationPlan {
  const mine = affiliations.filter((a) => a.organizationId === organizationId);
  const isCurrent = (a: AffiliationRecord) => a.statusLabel === currentStatusLabel;
  const reuse = mine.find((a) => isCurrent(a) && a.primary) ?? mine.find(isCurrent) ?? mine.find((a) => !a.portalAccess) ?? null;
  if (reuse === null && mine.length > 0) return { kind: 'needsStaff', affiliation: mine[0]! };
  const clearPrimaryOn = affiliations.filter((a) => a.primary && a.id !== reuse?.id);
  const alreadyDone = reuse !== null && isCurrent(reuse) && reuse.primary;
  if (alreadyDone && clearPrimaryOn.length === 0) return { kind: 'noChange' };
  return { kind: 'apply', reuseAffiliationId: reuse?.id ?? null, clearPrimaryOn };
}

// For staff on the log item: each affiliation that lost Primary, with its real Status, so they can
// mark it Former if the donor has left.
export function previousPrimaryNote(clearPrimaryOn: AffiliationRecord[]): string {
  if (clearPrimaryOn.length === 0) return '';
  const names = clearPrimaryOn.map((a) => `${a.organizationName ?? '(no Organization)'} (${a.statusLabel ?? 'no Status'})`).join(', ');
  return ` (previous Primary: ${names})`;
}
