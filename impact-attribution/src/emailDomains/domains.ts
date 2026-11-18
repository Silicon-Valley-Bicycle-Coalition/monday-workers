// Which Organization an email domain belongs to (GL#124). Built fresh each run from what the CRM
// already holds: config overrides, Work Emails on Current affiliations, and Organization
// websites. A domain the sources disagree on is ambiguous and proposes nothing until staff add an
// override.

export interface OrganizationRecord { itemId: string; name: string; websiteUrl: string | null }

export interface AffiliationRecord {
  itemId: string;
  personIds: string[];
  organizationIds: string[];
  status: string | null;
  workEmail: string | null;
}

export type MapSource = 'override' | 'Work Email match' | 'Website match';

export interface DomainMap {
  mapped: Map<string, { organizationId: string; source: MapSource }>;
  ambiguous: Set<string>;
}

export type DomainLookup =
  | { kind: 'mapped'; domain: string; organizationId: string; source: MapSource }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

// The domain of an address, lower-cased; null unless it has a non-empty local part and a domain
// of at least two non-empty labels.
export function emailDomain(address: string | null): string | null {
  const s = (address ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const domain = s.slice(at + 1);
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => l === '')) return null;
  return domain;
}

// Copied from salesforce-import/src/transform/emailKind.ts (Workers copy rather than share).
export function websiteDomain(url: string | null): string | null {
  let s = (url ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  s = s.split(/[/?#]/)[0] ?? ''; // path, query, fragment
  s = s.split(':')[0] ?? ''; // port
  s = s.replace(/^www\./, '');
  return s || null;
}

export function buildDomainMap(
  orgs: OrganizationRecord[],
  affiliations: AffiliationRecord[],
  opts: { currentLabel: string; overrides: Record<string, string>; platformDomains?: ReadonlySet<string> },
): DomainMap {
  const fromWork = new Map<string, Set<string>>();
  const fromWebsite = new Map<string, Set<string>>();
  const add = (into: Map<string, Set<string>>, domain: string | null, orgId: string) => {
    if (domain === null) return;
    const set = into.get(domain) ?? new Set<string>();
    set.add(orgId);
    into.set(domain, set);
  };
  for (const a of affiliations) {
    if (a.status !== opts.currentLabel || a.organizationIds.length !== 1) continue;
    add(fromWork, emailDomain(a.workEmail), a.organizationIds[0]!);
  }
  // A Website on a social or hosting platform (linkedin.com/company/foo) names the platform, not
  // the organization: it would map every employee of the platform to that organization.
  for (const o of orgs) {
    const domain = websiteDomain(o.websiteUrl);
    if (domain !== null && opts.platformDomains !== undefined && onPlatform(domain, opts.platformDomains)) continue;
    add(fromWebsite, domain, o.itemId);
  }

  const mapped: DomainMap['mapped'] = new Map();
  const ambiguous = new Set<string>();
  for (const domain of new Set([...fromWork.keys(), ...fromWebsite.keys()])) {
    const all = new Set([...(fromWork.get(domain) ?? []), ...(fromWebsite.get(domain) ?? [])]);
    if (all.size !== 1) { ambiguous.add(domain); continue; }
    const organizationId = [...all][0]!;
    mapped.set(domain, { organizationId, source: fromWork.has(domain) ? 'Work Email match' : 'Website match' });
  }
  for (const [domain, organizationId] of Object.entries(opts.overrides)) {
    ambiguous.delete(domain);
    mapped.set(domain, { organizationId, source: 'override' });
  }
  return { mapped, ambiguous };
}

function onPlatform(domain: string, platforms: ReadonlySet<string>): boolean {
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i++) if (platforms.has(labels.slice(i).join('.'))) return true;
  return false;
}

// Walks from the full domain up one label at a time (never down to a bare TLD); the first
// candidate that is blocked, mapped or ambiguous decides. So an excluded subdomain
// (alumni.stanford.edu) wins over its mapped parent, while a sibling (cs.stanford.edu) still maps.
// Under a blocked TLD (`edu`: students share the domain with staff) only an override maps; a
// Website or Work Email hit there is passed over, and so is an ambiguous one.
export function lookupDomain(
  map: DomainMap, domain: string | null, blocked: ReadonlySet<string>, blockedTlds: ReadonlySet<string> = new Set(),
): DomainLookup {
  if (domain === null) return { kind: 'none' };
  const labels = domain.split('.');
  const overrideOnly = blockedTlds.has(labels[labels.length - 1]!);
  for (let i = 0; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join('.');
    if (blocked.has(candidate)) return { kind: 'none' };
    const hit = map.mapped.get(candidate);
    if (hit && (!overrideOnly || hit.source === 'override')) return { kind: 'mapped', domain: candidate, ...hit };
    if (!overrideOnly && map.ambiguous.has(candidate)) return { kind: 'ambiguous' };
  }
  return { kind: 'none' };
}
