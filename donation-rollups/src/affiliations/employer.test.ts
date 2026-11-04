import { describe, it, expect } from 'vitest';
import { employerNameFor, type EmployerAffiliation } from './employer';

const aff = (id: string, over: Partial<EmployerAffiliation> = {}): EmployerAffiliation =>
  ({ id, statusLabel: 'Current', primary: false, organizationName: `Org ${id}`, ...over });

describe('employerNameFor', () => {
  it('names the organization of the only current affiliation', () => {
    expect(employerNameFor([aff('a')], 'a', 'Current')).toBe('Org a');
  });
  it('prefers a primary affiliation over the one that just changed', () => {
    expect(employerNameFor([aff('a'), aff('b', { primary: true })], 'a', 'Current')).toBe('Org b');
  });
  it('without a primary, the affiliation that just changed wins', () => {
    expect(employerNameFor([aff('a'), aff('b')], 'b', 'Current')).toBe('Org b');
  });
  it('among several primaries, the affiliation that just changed wins', () => {
    expect(employerNameFor([aff('a', { primary: true }), aff('b', { primary: true })], 'b', 'Current')).toBe('Org b');
  });
  it('falls back to the first current one when the changed affiliation is no longer current', () => {
    expect(employerNameFor([aff('a'), aff('b', { statusLabel: 'Former' })], 'b', 'Current')).toBe('Org a');
  });
  it('returns null for draft and former affiliations, even a primary one', () => {
    expect(employerNameFor([aff('a', { statusLabel: 'Draft', primary: true }), aff('b', { statusLabel: 'Former' })], 'a', 'Current')).toBeNull();
  });
  it('skips an affiliation with no organization linked', () => {
    expect(employerNameFor([aff('a', { organizationName: null, primary: true }), aff('b')], 'a', 'Current')).toBe('Org b');
  });
});
