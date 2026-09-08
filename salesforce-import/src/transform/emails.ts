import { collapseEmail } from './fields.js';
import { classifyDomain, emailDomain } from './emailKind.js';

export interface AffiliationRef { sfId: string; orgSfId: string; primary: boolean }
export interface EmailOverride { email: string; kind: 'personal' | 'household' | 'work'; affiliationSfId: string | null }
export interface EmailAssignment {
  personal: string | null;
  household: string | null;
  work: Map<string, string>;
  swapped: boolean;
  review: { email: string; domain: string }[];
}

const KINDS = new Set(['personal', 'household', 'work']);

// data/enrich/email-kinds.csv — a human's answer for addresses the domain rules couldn't
// place (rows copied from data/review/email-classification.csv). Header: email,kind,affiliationSfId.
export function parseEmailKindOverrides(csv: string): Map<string, EmailOverride> {
  const out = new Map<string, EmailOverride>();
  for (const line of csv.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [emailRaw = '', kindRaw = '', afRaw = ''] = line.split(',').map((s) => s.trim());
    const email = emailRaw.toLowerCase();
    const kind = kindRaw.toLowerCase();
    if (!email || !KINDS.has(kind)) continue;
    out.set(email, { email, kind: kind as EmailOverride['kind'], affiliationSfId: afRaw || null });
  }
  return out;
}

type Placed = { kind: 'work'; affiliationSfId: string } | { kind: 'personal' } | { kind: 'household' } | { kind: 'unknown' };

function pickAffiliationForOrg(affiliations: readonly AffiliationRef[], orgSfId: string): AffiliationRef | null {
  const atOrg = affiliations.filter((a) => a.orgSfId === orgSfId);
  return atOrg.find((a) => a.primary) ?? atOrg[0] ?? null;
}

export function assignEmails(
  contact: Record<string, unknown>,
  affiliations: readonly AffiliationRef[],
  orgDomainByOrgId: ReadonlyMap<string, string>,
  consumerDomains: ReadonlySet<string>,
  overrides: ReadonlyMap<string, EmailOverride>,
): EmailAssignment {
  const primary = collapseEmail(contact);
  const secondary = (contact['Secondary_Email__c'] as string | null)?.trim().toLowerCase() || null;
  const candidateOrgIds = affiliations.map((a) => a.orgSfId);

  const place = (email: string): Placed => {
    const o = overrides.get(email);
    if (o?.kind === 'work' && o.affiliationSfId) return { kind: 'work', affiliationSfId: o.affiliationSfId };
    if (o?.kind === 'personal') return { kind: 'personal' };
    if (o?.kind === 'household') return { kind: 'household' };
    const d = classifyDomain(emailDomain(email), candidateOrgIds, orgDomainByOrgId, consumerDomains);
    if (d.kind === 'work') {
      const af = pickAffiliationForOrg(affiliations, d.orgSfId);
      if (af) return { kind: 'work', affiliationSfId: af.sfId };
    }
    return d.kind === 'consumer' ? { kind: 'personal' } : { kind: 'unknown' };
  };

  const out: EmailAssignment = { personal: primary, household: null, work: new Map(), swapped: false, review: [] };
  if (!primary && !secondary) return out;

  const primaryPlaced = primary ? place(primary) : null;
  const secondaryPlaced = secondary ? place(secondary) : null;

  if (secondary && secondaryPlaced) {
    if (secondaryPlaced.kind === 'work') out.work.set(secondaryPlaced.affiliationSfId, secondary);
    else {
      out.household = secondary;
      if (secondaryPlaced.kind === 'unknown') out.review.push({ email: secondary, domain: emailDomain(secondary) ?? '' });
    }
  }

  // The one swap: primary is demonstrably a work address and the secondary is demonstrably a
  // personal mailbox. Any other shape keeps the primary as Personal.
  if (primary && primaryPlaced?.kind === 'work' && secondary && secondaryPlaced?.kind === 'personal') {
    out.personal = secondary;
    out.household = null;
    out.work.set(primaryPlaced.affiliationSfId, primary);
    out.swapped = true;
  }
  return out;
}
