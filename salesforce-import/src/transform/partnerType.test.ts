import { describe, it, expect } from 'vitest';
import { PARTNER_TYPES, partnerTypeFor } from './partnerType.js';

describe('partnerTypeFor', () => {
  it('maps the examples approved in #55', () => {
    expect(partnerTypeFor('Individual or Family Foundation')).toBe('Foundation');
    expect(partnerTypeFor('Government Committee')).toBe('Municipal');
    expect(partnerTypeFor('Public Sector')).toBe('Municipal');
    expect(partnerTypeFor('School District')).toBe('Education');
    expect(partnerTypeFor('Community Based/Nonprofit')).toBe('Nonprofit');
    expect(partnerTypeFor('Outdoor Shop')).toBe('Bike Shop');
    expect(partnerTypeFor('BTWD Participant')).toBe('Other');
    expect(partnerTypeFor('Prospect')).toBe('Other');
  });

  it('keeps every approved value as itself, so a re-run never moves one', () => {
    for (const type of PARTNER_TYPES) expect(partnerTypeFor(type)).toBe(type);
  });

  it('merges the two spellings of Advocacy Group', () => {
    expect(partnerTypeFor('Advocacy group')).toBe('Advocacy Group');
  });

  it('resolves a multipicklist to its most specific value, whatever the order', () => {
    expect(partnerTypeFor('Advocacy group;Government Committee;Bike Industry')).toBe('Municipal');
    expect(partnerTypeFor('Bike Industry;Government Committee;Advocacy group')).toBe('Municipal');
    expect(partnerTypeFor('Corporation;Bike Shop')).toBe('Bike Shop');
    expect(partnerTypeFor('Advocacy group;Foundation;Environment')).toBe('Foundation');
    expect(partnerTypeFor('Community Based Organizations;Education')).toBe('Education');
    expect(partnerTypeFor('Corporation;Athletics')).toBe('Corporation');
  });

  it('reads blank as no type, for the Untyped worklist', () => {
    expect(partnerTypeFor('')).toBe('');
    expect(partnerTypeFor('  ')).toBe('');
  });

  it('refuses a value it has never seen, even beside a known one', () => {
    expect(partnerTypeFor('Sponsor')).toBeUndefined();
    expect(partnerTypeFor('Corporation;Sponsor')).toBeUndefined();
  });

  // Every value in Type, Type_2__c and Industry on the 2026-10-27 extract, split on ";".
  it.each([
    'Advocacy Group', 'Advocacy group', 'Apparel', 'Athletics', 'BTWD Participant', 'Banking', 'Bike Club',
    'Bike Industry', 'Bike Shop', 'Bike Shop Nonprofit', 'Biotechnology', 'Community Based Organizations',
    'Community Based/Nonprofit', 'Construction', 'Construction/Development', 'Consulting', 'Consulting Firm',
    'Corporation', 'County District', 'Education', 'Engineering', 'Engineering / Planning', 'Environment',
    'Environmental', 'Event organizer', 'Finance', 'Food & Beverage', 'Foundation', 'Government Committee',
    'Health', 'Healthcare', 'Hospitality', 'Housing', 'Individual or Family Foundation', 'Insurance', 'Legal',
    'Manufacturing', 'Media', 'Member Organization', 'Music/Arts/Culture', 'Neighborhood Associations', 'Other',
    'Other Private Sector', 'Outdoor Shop', 'Press', 'Private Sector', 'Prospect', 'Public Sector', 'Retail',
    'School District', 'Service Club', 'Small local business', 'Technology', 'Technology Partner', 'Transportation',
    'Utilities', 'Venture Capital',
  ])('maps the live value %s into the vocabulary', (value) => {
    expect(PARTNER_TYPES).toContain(partnerTypeFor(value));
  });
});
