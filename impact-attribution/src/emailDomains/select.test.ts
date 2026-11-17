import { describe, it, expect } from 'vitest';
import { pairKey } from '../rule';
import { buildDomainMap, type AffiliationRecord, type OrganizationRecord } from './domains';
import { selectProposals, type PersonRecord } from './select';

const labels = { current: 'Current', draft: 'Draft', former: 'Former' };
const organizations: OrganizationRecord[] = [
  { itemId: 'o1', name: 'Acme', websiteUrl: 'https://acme.example' },
  { itemId: 'o2', name: 'Globex', websiteUrl: 'https://globex.example' },
  { itemId: 'o3', name: 'Twin A', websiteUrl: 'https://twin.example' },
  { itemId: 'o4', name: 'Twin B', websiteUrl: 'https://twin.example' },
];
const person = (over: Partial<PersonRecord> = {}): PersonRecord => ({
  itemId: '100', boardId: '18437909781', name: 'Jo Doe',
  personalEmail: 'jo@acme.example', householdEmail: null, employerName: null, lastGiftDate: null, ...over,
});
const aff = (over: Partial<AffiliationRecord>): AffiliationRecord => ({
  itemId: 'a1', personIds: ['100'], organizationIds: ['o1'], status: 'Current', workEmail: null, ...over,
});

function select(people: PersonRecord[], affiliations: AffiliationRecord[] = [], extra: { proposedPairs?: Set<string>; cap?: number } = {}) {
  return selectProposals({
    people, affiliations, organizations,
    domainMap: buildDomainMap(organizations, affiliations, { currentLabel: 'Current', overrides: {} }),
    blocked: new Set(['gmail.com']),
    proposedPairs: extra.proposedPairs ?? new Set(),
    labels, cap: extra.cap ?? 25,
  });
}

describe('selectProposals', () => {
  it('proposes the organization behind a company Personal Email', () => {
    const { proposals } = select([person()]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      organizationId: 'o1', organizationName: 'Acme', domain: 'acme.example',
      proposedFrom: 'Proposed from email domain acme.example (Personal Email; Website match).',
    });
  });

  it('shows the Salesforce Employer Name for comparison', () => {
    const { proposals } = select([person({ employerName: 'Acme Inc' })]);
    expect(proposals[0]!.proposedFrom).toBe('Proposed from email domain acme.example (Personal Email; Website match). Salesforce employer: Acme Inc.');
  });

  it('names Household Email when that is the company address', () => {
    const { proposals } = select([person({ personalEmail: 'jo@gmail.com', householdEmail: 'fam@globex.example' })]);
    expect(proposals[0]).toMatchObject({ organizationId: 'o2', proposedFrom: 'Proposed from email domain globex.example (Household Email; Website match).' });
  });

  it('names Personal Email when both addresses point at one organization', () => {
    const { proposals } = select([person({ householdEmail: 'fam@acme.example' })]);
    expect(proposals[0]!.proposedFrom).toContain('(Personal Email;');
  });

  it('does not count a person with only consumer or unknown addresses', () => {
    const r = select([person({ personalEmail: 'jo@gmail.com' }), person({ itemId: '101', personalEmail: 'x@nowhere.example' })]);
    expect(r.proposals).toEqual([]);
    expect(Object.values(r.skipped).every((n) => n === 0)).toBe(true);
  });

  it('skips a person with any Current affiliation', () => {
    const r = select([person()], [aff({ organizationIds: ['o2'], status: 'Current' })]);
    expect(r.proposals).toEqual([]);
    expect(r.skipped.hasCurrentOrDraft).toBe(1);
  });

  it('skips a person with a Draft at a different organization', () => {
    const r = select([person()], [aff({ organizationIds: ['o2'], status: 'Draft' })]);
    expect(r.proposals).toEqual([]);
    expect(r.skipped.hasCurrentOrDraft).toBe(1);
  });

  it('skips a person who used to work at that organization', () => {
    const r = select([person()], [aff({ organizationIds: ['o1'], status: 'Former' })]);
    expect(r.proposals).toEqual([]);
    expect(r.skipped.formerAtOrg).toBe(1);
  });

  it('proposes despite a Former affiliation elsewhere', () => {
    expect(select([person()], [aff({ organizationIds: ['o2'], status: 'Former' })]).proposals).toHaveLength(1);
  });

  it('never re-proposes a pair it proposed before', () => {
    const r = select([person()], [], { proposedPairs: new Set([pairKey('100', 'o1')]) });
    expect(r.proposals).toEqual([]);
    expect(r.skipped.alreadyProposed).toBe(1);
  });

  it('skips a person whose two addresses point at two organizations', () => {
    const r = select([person({ householdEmail: 'fam@globex.example' })]);
    expect(r.proposals).toEqual([]);
    expect(r.skipped.twoEmployers).toBe(1);
  });

  it('skips a person whose only company domain is ambiguous', () => {
    const r = select([person({ personalEmail: 'jo@twin.example' })]);
    expect(r.proposals).toEqual([]);
    expect(r.skipped.ambiguousDomain).toBe(1);
  });

  it('an affiliation with no Person link counts for nobody', () => {
    expect(select([person()], [aff({ personIds: [], status: 'Current' })]).proposals).toHaveLength(1);
  });

  it('proposes for a People (Historical) person and keeps their board', () => {
    const { proposals } = select([person({ boardId: '18437909784' })]);
    expect(proposals[0]!.person.boardId).toBe('18437909784');
  });

  it('takes recent donors first and defers the rest past the cap', () => {
    const people: PersonRecord[] = [];
    for (let i = 0; i < 30; i++) {
      const day = String((i % 28) + 1).padStart(2, '0');
      people.push(person({ itemId: String(1000 + i), lastGiftDate: i < 25 ? `2026-${i < 12 ? '10' : '09'}-${day}` : null }));
    }
    const r = select(people, [], { cap: 25 });
    expect(r.proposals).toHaveLength(25);
    expect(r.deferred).toBe(5);
    expect(r.proposals.every((p) => p.person.lastGiftDate !== null)).toBe(true);
    const dates = r.proposals.map((p) => p.person.lastGiftDate!);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('proposes once for a person read twice (moved between People boards mid-read)', () => {
    const r = select([person({ itemId: '100' }), person({ itemId: '100', boardId: '18437909784' })]);
    expect(r.proposals).toHaveLength(1);
  });

  it('orders people without a gift by item id', () => {
    const r = select([person({ itemId: '30' }), person({ itemId: '4' }), person({ itemId: '200' })], [], { cap: 2 });
    expect(r.proposals.map((p) => p.person.itemId)).toEqual(['4', '30']);
    expect(r.deferred).toBe(1);
  });
});
