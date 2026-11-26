import { describe, it, expect } from 'vitest';
import { planAffiliationChange, previousPrimaryNote, type AffiliationRecord } from './employer';
import { normalizeEmployerName, organizationNameVariants, pickOrganization } from './employerName';

const aff = (over: Partial<AffiliationRecord> & { id: string }): AffiliationRecord => ({
  organizationId: null,
  organizationName: null,
  statusLabel: 'Current',
  primary: false,
  portalAccess: false,
  ...over,
});

describe('normalizeEmployerName', () => {
  it.each([
    ['  Google, LLC ', 'google'],
    ['Acme Corporation', 'acme'],
    ['Acme Co.', 'acme'],
    ['AT&T Inc.', 'att'],
    ['Hewlett-Packard', 'hewlettpackard'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeEmployerName(input)).toBe(expected);
  });

  it('punctuation normalises identically on both sides', () => {
    expect(normalizeEmployerName('AT&T')).toBe(normalizeEmployerName('AT & T, Inc.'));
  });

  it('keeps non-Latin letters', () => {
    expect(normalizeEmployerName('Société Générale')).toBe('sociétégénérale');
  });
});

describe('organizationNameVariants', () => {
  it('generates the bare stem and every suffix spelling, without duplicates', () => {
    const variants = organizationNameVariants('Google');
    for (const v of ['Google', 'Google, LLC', 'Google LLC', 'Google, Inc.', 'Google Inc.', 'Google Inc', 'Google, Inc', 'Google Corp', 'Google Corporation', 'Google Ltd', 'Google Co']) {
      expect(variants).toContain(v);
    }
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('includes the typed name and its stem when the donor typed a suffix', () => {
    const variants = organizationNameVariants('Google LLC');
    expect(variants).toContain('Google LLC');
    expect(variants).toContain('Google');
    expect(organizationNameVariants('Google, Inc.')).toContain('Google');
  });

  it('empty stem yields no variants', () => {
    expect(organizationNameVariants('Inc.')).toEqual([]);
    expect(organizationNameVariants('  — ')).toEqual([]);
  });
});

describe('pickOrganization', () => {
  it('one normalised match', () => {
    const google = { id: '1', name: 'Google, LLC' };
    expect(pickOrganization('google', [google, { id: '2', name: 'Googleplex Cafe' }])).toEqual({ kind: 'one', organization: google });
  });

  it('no normalised match', () => {
    expect(pickOrganization('Acme', [{ id: '2', name: 'Acme Tools' }])).toEqual({ kind: 'none' });
  });

  it('several normalised matches', () => {
    const a = { id: '1', name: 'Acme Corp' };
    const b = { id: '2', name: 'ACME Inc' };
    expect(pickOrganization('Acme', [a, b])).toEqual({ kind: 'several', organizations: [a, b] });
  });

  it('empty typed name never matches', () => {
    expect(pickOrganization('Inc.', [{ id: '1', name: 'Inc' }])).toEqual({ kind: 'none' });
  });
});

describe('planAffiliationChange', () => {
  it('no affiliations → create', () => {
    expect(planAffiliationChange([], 'O1', 'Current')).toEqual({ kind: 'apply', reuseAffiliationId: null, clearPrimaryOn: [] });
  });

  it('already Current and Primary, nothing else Primary → no change', () => {
    const a = aff({ id: 'a', organizationId: 'O1', primary: true });
    expect(planAffiliationChange([a], 'O1', 'Current')).toEqual({ kind: 'noChange' });
  });

  it.each(['Former', 'Draft'])('reuses an existing %s affiliation', (status) => {
    const a = aff({ id: 'a', organizationId: 'O1', statusLabel: status });
    expect(planAffiliationChange([a], 'O1', 'Current')).toEqual({ kind: 'apply', reuseAffiliationId: 'a', clearPrimaryOn: [] });
  });

  it('sends a Former affiliation with Portal access to staff instead of reviving it', () => {
    const a = aff({ id: 'a', organizationId: 'O1', statusLabel: 'Former', portalAccess: true });
    expect(planAffiliationChange([a], 'O1', 'Current')).toEqual({ kind: 'needsStaff', affiliation: a });
  });

  it('reuses a Former affiliation without Portal access ahead of one with it', () => {
    const access = aff({ id: 'a', organizationId: 'O1', statusLabel: 'Former', portalAccess: true });
    const plain = aff({ id: 'b', organizationId: 'O1', statusLabel: 'Former' });
    expect(planAffiliationChange([access, plain], 'O1', 'Current')).toMatchObject({ kind: 'apply', reuseAffiliationId: 'b' });
  });

  it('still reuses a Current affiliation that has Portal access', () => {
    const a = aff({ id: 'a', organizationId: 'O1', portalAccess: true });
    expect(planAffiliationChange([a], 'O1', 'Current')).toEqual({ kind: 'apply', reuseAffiliationId: 'a', clearPrimaryOn: [] });
  });

  it('prefers the Current one of several affiliations to the same Organization', () => {
    const former = aff({ id: 'f', organizationId: 'O1', statusLabel: 'Former' });
    const current = aff({ id: 'c', organizationId: 'O1' });
    expect(planAffiliationChange([former, current], 'O1', 'Current')).toMatchObject({ reuseAffiliationId: 'c' });
  });

  it('clears Primary on another Organization, leaves non-Primary ones alone', () => {
    const other = aff({ id: 'o', organizationId: 'O2', organizationName: 'Acme', primary: true });
    const side = aff({ id: 's', organizationId: 'O3' });
    expect(planAffiliationChange([other, side], 'O1', 'Current')).toEqual({ kind: 'apply', reuseAffiliationId: null, clearPrimaryOn: [other] });
  });

  it('clears Primary on an affiliation with no Organization linked', () => {
    const orphan = aff({ id: 'x', primary: true });
    expect(planAffiliationChange([orphan], 'O1', 'Current')).toMatchObject({ clearPrimaryOn: [orphan] });
  });

  it('matched is already Current and Primary but another is Primary too → apply', () => {
    const mine = aff({ id: 'm', organizationId: 'O1', primary: true });
    const other = aff({ id: 'o', organizationId: 'O2', primary: true });
    expect(planAffiliationChange([mine, other], 'O1', 'Current')).toEqual({ kind: 'apply', reuseAffiliationId: 'm', clearPrimaryOn: [other] });
  });
});

describe('planAffiliationChange — same-Organization duplicates', () => {
  it('clears Primary on a same-Organization duplicate it does not reuse', () => {
    const current = aff({ id: 'a', organizationId: 'O1' });
    const dupPrimary = aff({ id: 'b', organizationId: 'O1', statusLabel: 'Former', primary: true });
    expect(planAffiliationChange([current, dupPrimary], 'O1', 'Current')).toEqual({ kind: 'apply', reuseAffiliationId: 'a', clearPrimaryOn: [dupPrimary] });
  });

  it('prefers a Current, Primary one, and is not noChange while a duplicate is also Primary', () => {
    const currentOnly = aff({ id: 'a', organizationId: 'O1' });
    const done = aff({ id: 'b', organizationId: 'O1', primary: true });
    const dup = aff({ id: 'c', organizationId: 'O1', statusLabel: 'Former', primary: true });
    expect(planAffiliationChange([currentOnly, done], 'O1', 'Current')).toEqual({ kind: 'noChange' });
    expect(planAffiliationChange([currentOnly, done, dup], 'O1', 'Current')).toEqual({ kind: 'apply', reuseAffiliationId: 'b', clearPrimaryOn: [dup] });
  });
});

describe('previousPrimaryNote', () => {
  it('names each previous Primary with its real Status', () => {
    expect(previousPrimaryNote([aff({ id: 'a', organizationName: 'Acme', statusLabel: 'Former' }), aff({ id: 'b', organizationName: 'Beta', statusLabel: null })]))
      .toBe(' (previous Primary: Acme (Former), Beta (no Status))');
  });

  it('empty when nothing was cleared', () => {
    expect(previousPrimaryNote([])).toBe('');
  });

  it('names the previous Primary', () => {
    expect(previousPrimaryNote([aff({ id: 'a', organizationName: 'Acme' })])).toBe(' (previous Primary: Acme (Current))');
  });

  it('says (no Organization) for an unlinked one', () => {
    expect(previousPrimaryNote([aff({ id: 'a' })])).toBe(' (previous Primary: (no Organization) (Current))');
  });

  it('joins several in one parenthesis', () => {
    expect(previousPrimaryNote([aff({ id: 'a', organizationName: 'Acme' }), aff({ id: 'b', organizationName: 'Beta' })]))
      .toBe(' (previous Primary: Acme (Current), Beta (Current))');
  });
});
