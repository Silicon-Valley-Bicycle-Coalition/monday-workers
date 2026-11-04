export interface EmployerAffiliation {
  id: string;
  statusLabel: string | null;
  primary: boolean;
  organizationName: string | null;
}

// Which organization a person's Employer Name should show after an affiliation changed: a current
// one, the Primary-flagged if there is one (so editing a side role can't displace the main job),
// then the one that just changed, then the first. Null when nothing is current: Draft is
// unconfirmed, and Former leaves the last known employer in place rather than blanking it.
export function employerNameFor(
  affiliations: readonly EmployerAffiliation[], changedItemId: string, currentStatusLabel: string,
): string | null {
  const current = affiliations.filter((a) => a.statusLabel === currentStatusLabel && a.organizationName !== null);
  const primaries = current.filter((a) => a.primary);
  const pool = primaries.length > 0 ? primaries : current;
  return (pool.find((a) => a.id === changedItemId) ?? pool[0])?.organizationName ?? null;
}
