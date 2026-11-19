import type { Config, DonorMatch } from '../types';
import { orgAccessEnabled, workEmailSignInEnabled } from '../config';
import type { MondayClient } from '../monday/client';
import { sha256Hex } from '../crypto/hash';
import { errorText } from '../logSafe';

// What a signed-in address may act for: one entry per Affiliation that grants access to an
// organization. Carried from the sign-in request through the token to the session.
export interface OrgGrant {
  orgItemId: string;
  affiliationItemId: string;
  via: 'person' | 'workEmail';
  // The Affiliation's person, recorded as a verified-email owner when via is 'workEmail'.
  personItemId: string | null;
}

interface GrantDeps {
  monday: MondayClient;
  config: Config;
}

interface AffiliationState {
  statusLabel: string | null;
  portalAccess: boolean;
  organizationId: string | null;
}

// Staff grant access per person: a Current Affiliation with Portal access ticked, linked to an
// organization (spec "Access").
function grantsAccess(aff: AffiliationState, currentStatusLabel: string): aff is AffiliationState & { organizationId: string } {
  return aff.statusLabel === currentStatusLabel && aff.portalAccess && aff.organizationId !== null;
}

// The organizations a sign-in address may act for. Only people whose Personal Email matched
// carry their Affiliations (a shared Household Email doesn't); a Work Email on a granting
// Affiliation adds that organization alone. One grant per organization, a person grant winning.
// Never throws: a failed read drops that read's grants, so sign-in for the person's own records
// goes on.
export async function resolveOrgGrants(email: string, matches: DonorMatch[], deps: GrantDeps): Promise<OrgGrant[]> {
  if (!orgAccessEnabled(deps.config)) return [];
  const employer = deps.config.changeRequests.employer!;
  const current = employer.currentStatusLabel;
  const byOrg = new Map<string, OrgGrant>();

  for (const match of matches) {
    if (!match.matchedPersonal) continue;
    try {
      const affiliations = await deps.monday.getPersonAffiliations({ donorItemId: match.id, employer });
      for (const aff of affiliations) {
        if (!grantsAccess(aff, current) || byOrg.has(aff.organizationId)) continue;
        byOrg.set(aff.organizationId, { orgItemId: aff.organizationId, affiliationItemId: aff.id, via: 'person', personItemId: match.id });
      }
    } catch (err) {
      console.error(`member-portal org grants: affiliations read failed for donor ${match.id}: ${errorText(err)}`);
    }
  }

  if (workEmailSignInEnabled(deps.config)) {
    try {
      const affiliations = await deps.monday.findAffiliationsByWorkEmail(email);
      for (const aff of affiliations) {
        if (!grantsAccess(aff, current) || byOrg.has(aff.organizationId)) continue;
        byOrg.set(aff.organizationId, { orgItemId: aff.organizationId, affiliationItemId: aff.id, via: 'workEmail', personItemId: aff.personItemId });
      }
    } catch (err) {
      console.error(`member-portal org grants: Work Email lookup failed: ${errorText(err)}`);
    }
  }

  return [...byOrg.values()];
}

// The live check every organization route runs first: re-reads the one granting Affiliation by id
// (the spec's "re-reads the session people's Affiliations": the same guarantee in one read, and it
// covers Work Email sessions, which hold no people). Still Current, Portal access still ticked,
// still linked to this organization; a Work Email grant also needs the Work Email to still be the
// address the session signed in with. Any failure reads as no access.
export async function hasOrgAccess(grant: OrgGrant, sessionEmailHash: string | null, deps: GrantDeps): Promise<boolean> {
  try {
    if (!orgAccessEnabled(deps.config)) return false;
    const aff = await deps.monday.getAffiliation(grant.affiliationItemId);
    if (aff === null) return false;
    const current = deps.config.changeRequests.employer!.currentStatusLabel;
    if (!grantsAccess(aff, current) || aff.organizationId !== grant.orgItemId) return false;
    if (grant.via === 'workEmail') {
      const workEmail = aff.workEmail.trim().toLowerCase();
      if (workEmail === '' || sessionEmailHash === null) return false;
      return (await sha256Hex(workEmail)) === sessionEmailHash;
    }
    return true;
  } catch (err) {
    console.error(`member-portal org access check failed for affiliation ${grant.affiliationItemId}: ${errorText(err)}`);
    return false;
  }
}

// Finds the session's grant for an org id; null when the session holds none.
export function grantFor(grants: OrgGrant[], orgItemId: string): OrgGrant | null {
  return grants.find((grant) => grant.orgItemId === orgItemId) ?? null;
}
