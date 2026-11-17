import { describe, it, expect } from 'vitest';
import { normalizeEmployerName, organizationNameVariants, pickOrganization } from './employerName';

describe('employerName (copy of member-portal/src/changeRequests/employerName.ts)', () => {
  it('normalizes punctuation, spacing and a trailing suffix', () => {
    expect(normalizeEmployerName('AT & T, Inc.')).toBe('att');
  });

  it('offers suffix spellings for a bare name', () => {
    expect(organizationNameVariants('Google')).toContain('Google, LLC');
  });

  it('picks the one Organization whose normalized name matches', () => {
    const google = { id: '1', name: 'Google, LLC' };
    expect(pickOrganization('google', [google, { id: '2', name: 'Googleplex' }])).toEqual({ kind: 'one', organization: google });
  });
});
