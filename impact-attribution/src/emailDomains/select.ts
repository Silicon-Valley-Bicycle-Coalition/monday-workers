import { pairKey } from '../rule';
import { emailDomain, lookupDomain, type AffiliationRecord, type DomainLookup, type DomainMap, type OrganizationRecord } from './domains';

// Who gets an employer proposed from an email domain this run (#124). Pure: the run reads the boards and the ledger,
// this decides, and the run writes.

export interface PersonRecord {
  itemId: string;
  boardId: string; // People or People (Historical)
  name: string;
  personalEmail: string | null;
  householdEmail: string | null;
  employerName: string | null; // Salesforce-era free text, shown for comparison only
  lastGiftDate: string | null; // YYYY-MM-DD
}

export interface Proposal {
  person: PersonRecord;
  organizationId: string;
  organizationName: string;
  domain: string;
  proposedFrom: string;
}

export type SkipReason = 'hasCurrentOrDraft' | 'formerAtOrg' | 'alreadyProposed' | 'twoEmployers' | 'ambiguousDomain';

export interface Selection { proposals: Proposal[]; deferred: number; skipped: Record<SkipReason, number> }

type Mapped = Extract<DomainLookup, { kind: 'mapped' }>;

export function selectProposals(input: {
  people: PersonRecord[];
  affiliations: AffiliationRecord[];
  organizations: OrganizationRecord[];
  domainMap: DomainMap;
  blocked: ReadonlySet<string>;
  proposedPairs: ReadonlySet<string>;
  labels: { current: string; draft: string; former: string };
  cap: number;
}): Selection {
  const { labels } = input;
  const skipped: Record<SkipReason, number> = {
    hasCurrentOrDraft: 0, formerAtOrg: 0, alreadyProposed: 0, twoEmployers: 0, ambiguousDomain: 0,
  };
  const orgName = new Map(input.organizations.map((o) => [o.itemId, o.name]));
  const affiliationsByPerson = new Map<string, AffiliationRecord[]>();
  for (const a of input.affiliations) {
    for (const p of a.personIds) {
      const list = affiliationsByPerson.get(p) ?? [];
      list.push(a);
      affiliationsByPerson.set(p, list);
    }
  }

  const eligible: Proposal[] = [];
  // A person moved between People boards while the boards were being read appears twice.
  const seen = new Set<string>();
  for (const person of input.people) {
    if (seen.has(person.itemId)) continue;
    seen.add(person.itemId);
    const sources: [string, DomainLookup][] = [
      ['Personal Email', lookupDomain(input.domainMap, emailDomain(person.personalEmail), input.blocked)],
      ['Household Email', lookupDomain(input.domainMap, emailDomain(person.householdEmail), input.blocked)],
    ];
    const mapped = sources.filter((s): s is [string, Mapped] => s[1].kind === 'mapped');
    if (mapped.length === 0) {
      if (sources.some(([, l]) => l.kind === 'ambiguous')) skipped.ambiguousDomain++;
      continue;
    }
    if (new Set(mapped.map(([, l]) => l.organizationId)).size > 1) { skipped.twoEmployers++; continue; }
    const [sourceColumn, hit] = mapped[0]!;

    const theirs = affiliationsByPerson.get(person.itemId) ?? [];
    if (theirs.some((a) => a.status === labels.current || a.status === labels.draft)) { skipped.hasCurrentOrDraft++; continue; }
    if (theirs.some((a) => a.status === labels.former && a.organizationIds.includes(hit.organizationId))) { skipped.formerAtOrg++; continue; }
    if (input.proposedPairs.has(pairKey(person.itemId, hit.organizationId))) { skipped.alreadyProposed++; continue; }

    let proposedFrom = `Proposed from email domain ${hit.domain} (${sourceColumn}; ${hit.source}).`;
    const employer = person.employerName?.trim();
    if (employer) proposedFrom += ` Salesforce employer: ${employer}.`;
    eligible.push({
      person, organizationId: hit.organizationId, organizationName: orgName.get(hit.organizationId) ?? hit.organizationId,
      domain: hit.domain, proposedFrom,
    });
  }

  // Recent donors first: that's where a matching gift is worth the most. Then everyone else, by
  // item id, so the order is stable from run to run.
  eligible.sort((a, b) => {
    const da = a.person.lastGiftDate, db = b.person.lastGiftDate;
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? 1 : -1;
    }
    return Number(a.person.itemId) - Number(b.person.itemId);
  });
  const proposals = eligible.slice(0, input.cap);
  return { proposals, deferred: eligible.length - proposals.length, skipped };
}
