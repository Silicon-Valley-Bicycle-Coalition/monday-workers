import { describe, it, expect } from 'vitest';
import {
  buildDomainMap, emailDomain, lookupDomain, websiteDomain,
  type AffiliationRecord, type OrganizationRecord,
} from './domains';

const org = (itemId: string, websiteUrl: string | null = null): OrganizationRecord => ({ itemId, name: `Org ${itemId}`, websiteUrl });
const aff = (over: Partial<AffiliationRecord>): AffiliationRecord => ({
  itemId: 'a', personIds: ['p'], organizationIds: ['o1'], status: 'Current', workEmail: null, ...over,
});
const opts = { currentLabel: 'Current', overrides: {} };

describe('emailDomain', () => {
  it('trims and lower-cases', () => {
    expect(emailDomain(' Jane@Google.COM ')).toBe('google.com');
  });

  it('rejects addresses with no usable domain', () => {
    for (const bad of ['nobody', 'a@', 'a@google.com.', '@google.com', '', null]) {
      expect(emailDomain(bad), String(bad)).toBeNull();
    }
  });
});

describe('websiteDomain', () => {
  it('strips scheme, www, path and case', () => {
    expect(websiteDomain('https://www.Google.com/about')).toBe('google.com');
  });

  it('is null for an empty value', () => {
    expect(websiteDomain(null)).toBeNull();
    expect(websiteDomain('')).toBeNull();
  });
});

describe('buildDomainMap', () => {
  it("maps a Current affiliation's Work Email domain", () => {
    const map = buildDomainMap([], [aff({ workEmail: 'jo@acme.example', organizationIds: ['o1'] })], opts);
    expect(map.mapped.get('acme.example')).toEqual({ organizationId: 'o1', source: 'Work Email match' });
  });

  it('ignores a Draft affiliation\'s Work Email', () => {
    const map = buildDomainMap([], [aff({ workEmail: 'jo@acme.example', status: 'Draft' })], opts);
    expect(map.mapped.has('acme.example')).toBe(false);
  });

  it('maps an organization website', () => {
    const map = buildDomainMap([org('o2', 'https://acme.example')], [], opts);
    expect(map.mapped.get('acme.example')).toEqual({ organizationId: 'o2', source: 'Website match' });
  });

  it('agreement between sources is a Work Email match', () => {
    const map = buildDomainMap([org('o1', 'acme.example')], [aff({ workEmail: 'jo@acme.example' })], opts);
    expect(map.mapped.get('acme.example')).toEqual({ organizationId: 'o1', source: 'Work Email match' });
  });

  it('two organizations with one website are ambiguous', () => {
    const map = buildDomainMap([org('o1', 'acme.example'), org('o2', 'www.acme.example')], [], opts);
    expect(map.mapped.has('acme.example')).toBe(false);
    expect(map.ambiguous.has('acme.example')).toBe(true);
  });

  it('Work Email and website naming different organizations is ambiguous', () => {
    const map = buildDomainMap([org('o2', 'acme.example')], [aff({ workEmail: 'jo@acme.example', organizationIds: ['o1'] })], opts);
    expect(map.ambiguous.has('acme.example')).toBe(true);
    expect(map.mapped.has('acme.example')).toBe(false);
  });

  it('Work Emails at one domain on two organizations are ambiguous', () => {
    const map = buildDomainMap([], [
      aff({ itemId: 'a1', workEmail: 'a@acme.example', organizationIds: ['o1'] }),
      aff({ itemId: 'a2', workEmail: 'b@acme.example', organizationIds: ['o2'] }),
    ], opts);
    expect(map.ambiguous.has('acme.example')).toBe(true);
  });

  it('an override beats an ambiguous domain', () => {
    const map = buildDomainMap([org('o1', 'acme.example'), org('o2', 'acme.example')], [],
      { currentLabel: 'Current', overrides: { 'acme.example': 'o3' } });
    expect(map.mapped.get('acme.example')).toEqual({ organizationId: 'o3', source: 'override' });
    expect(map.ambiguous.has('acme.example')).toBe(false);
  });

  it('a platform website (LinkedIn page) maps nothing, while Work Emails at that platform still do', () => {
    const map = buildDomainMap(
      [org('foo', 'https://www.linkedin.com/company/foo')],
      [aff({ workEmail: 'pat@linkedin.com', organizationIds: ['li'] })],
      { ...opts, platformDomains: new Set(['linkedin.com']) },
    );
    expect(map.mapped.get('linkedin.com')).toEqual({ organizationId: 'li', source: 'Work Email match' });
    expect(map.ambiguous.has('linkedin.com')).toBe(false);
  });

  it('ignores an affiliation with no organization or two of them', () => {
    const map = buildDomainMap([], [
      aff({ itemId: 'a1', workEmail: 'a@one.example', organizationIds: [] }),
      aff({ itemId: 'a2', workEmail: 'b@two.example', organizationIds: ['o1', 'o2'] }),
    ], opts);
    expect(map.mapped.size).toBe(0);
    expect(map.ambiguous.size).toBe(0);
  });
});

describe('lookupDomain', () => {
  const map = buildDomainMap([org('stan', 'https://www.stanford.edu'), org('g', 'gmail.com')], [], opts);

  it('matches a subdomain to its parent', () => {
    expect(lookupDomain(map, 'cs.stanford.edu', new Set())).toEqual(
      { kind: 'mapped', domain: 'stanford.edu', organizationId: 'stan', source: 'Website match' });
  });

  it('a blocked subdomain is none while a sibling still maps', () => {
    const blocked = new Set(['alumni.stanford.edu']);
    expect(lookupDomain(map, 'alumni.stanford.edu', blocked)).toEqual({ kind: 'none' });
    expect(lookupDomain(map, 'mail.alumni.stanford.edu', blocked)).toEqual({ kind: 'none' });
    expect(lookupDomain(map, 'cs.stanford.edu', blocked).kind).toBe('mapped');
  });

  it('a blocked domain is none even when an organization uses it', () => {
    expect(lookupDomain(map, 'gmail.com', new Set(['gmail.com']))).toEqual({ kind: 'none' });
  });

  it('reports an ambiguous domain', () => {
    const amb = buildDomainMap([org('o1', 'acme.example'), org('o2', 'acme.example')], [], opts);
    expect(lookupDomain(amb, 'acme.example', new Set())).toEqual({ kind: 'ambiguous' });
  });

  it('is none for an unknown or missing domain, and never matches a bare TLD', () => {
    const tld = buildDomainMap([org('o', 'https://edu')], [], opts);
    expect(lookupDomain(tld, 'stanford.edu', new Set())).toEqual({ kind: 'none' });
    expect(lookupDomain(map, 'unknown.example', new Set())).toEqual({ kind: 'none' });
    expect(lookupDomain(map, null, new Set())).toEqual({ kind: 'none' });
  });
});

describe('lookupDomain with blocked TLDs (review of !502)', () => {
  const orgs: OrganizationRecord[] = [
    { itemId: 'su', name: 'Stanford University', websiteUrl: 'https://www.stanford.edu' },
    { itemId: 'sjsu', name: 'San José State University', websiteUrl: 'https://sjsu.edu' },
  ];
  const tlds = new Set(['edu']);

  it('does not map a university domain from its Website: students share it with staff', () => {
    const map = buildDomainMap(orgs, [], { currentLabel: 'Current', overrides: {} });
    expect(lookupDomain(map, 'stanford.edu', new Set(), tlds)).toEqual({ kind: 'none' });
    expect(lookupDomain(map, 'cs.stanford.edu', new Set(), tlds)).toEqual({ kind: 'none' });
  });

  it('does not map one from a Current Work Email either', () => {
    const affs = [{ itemId: 'a', personIds: ['1'], organizationIds: ['sjsu'], status: 'Current', workEmail: 'x@sjsu.edu' }];
    const map = buildDomainMap(orgs, affs, { currentLabel: 'Current', overrides: {} });
    expect(lookupDomain(map, 'sjsu.edu', new Set(), tlds)).toEqual({ kind: 'none' });
  });

  it('maps one an override names, subdomains included, and an excluded subdomain still wins', () => {
    const map = buildDomainMap(orgs, [], { currentLabel: 'Current', overrides: { 'stanford.edu': 'su' } });
    expect(lookupDomain(map, 'cs.stanford.edu', new Set(), tlds)).toMatchObject({ kind: 'mapped', organizationId: 'su', source: 'override' });
    expect(lookupDomain(map, 'alumni.stanford.edu', new Set(['alumni.stanford.edu']), tlds)).toEqual({ kind: 'none' });
  });

  it('does not report an ambiguous university domain as ambiguous: it is blocked', () => {
    const map = buildDomainMap([...orgs, { itemId: 'su2', name: 'Stanford dup', websiteUrl: 'stanford.edu' }], [], { currentLabel: 'Current', overrides: {} });
    expect(lookupDomain(map, 'stanford.edu', new Set(), tlds)).toEqual({ kind: 'none' });
  });
});

