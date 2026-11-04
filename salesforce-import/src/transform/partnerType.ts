// The Organizations Partner Type vocabulary, approved 2026-10-28 (#55), in display order.
export const PARTNER_TYPES = ['Municipal', 'Corporation', 'Bike Shop', 'Bike Club', 'Advocacy Group',
  'Foundation', 'Nonprofit', 'Press', 'Education', 'Other'] as const;
export type PartnerType = (typeof PARTNER_TYPES)[number];

// A multipicklist keeps the value that says most about what the organization is: a BPAC tagged
// "Advocacy group;Government Committee;Bike Industry" is a government body first. Corporation and
// Other sit last because the sector tags that map to them say the least.
const MOST_SPECIFIC_FIRST: readonly PartnerType[] = ['Municipal', 'Bike Shop', 'Bike Club', 'Foundation',
  'Education', 'Press', 'Advocacy Group', 'Nonprofit', 'Corporation', 'Other'];

const GROUPS: Record<PartnerType, readonly string[]> = {
  'Municipal': ['Municipal', 'Government Committee', 'Public Sector', 'County District'],
  'Bike Shop': ['Bike Shop', 'Bike Shop Nonprofit', 'Outdoor Shop'],
  'Bike Club': ['Bike Club'],
  'Foundation': ['Foundation', 'Individual or Family Foundation'],
  'Education': ['Education', 'School District'],
  'Press': ['Press', 'Media'],
  'Advocacy Group': ['Advocacy Group'],
  'Nonprofit': ['Nonprofit', 'Community Based/Nonprofit', 'Community Based Organizations', 'Neighborhood Associations',
    'Service Club', 'Housing', 'Environment', 'Music/Arts/Culture'],
  // Salesforce's Industry picklist and the for-profit Type_2__c sectors.
  'Corporation': ['Corporation', 'Private Sector', 'Other Private Sector', 'Small local business', 'Bike Industry',
    'Technology', 'Technology Partner', 'Biotechnology', 'Transportation', 'Legal', 'Consulting', 'Consulting Firm',
    'Engineering', 'Engineering / Planning', 'Construction', 'Construction/Development', 'Finance', 'Banking',
    'Insurance', 'Venture Capital', 'Food & Beverage', 'Hospitality', 'Retail', 'Apparel', 'Manufacturing',
    'Utilities', 'Health', 'Healthcare', 'Environmental'],
  'Other': ['Other', 'Prospect', 'BTWD Participant', 'Member Organization', 'Athletics', 'Event organizer'],
};

const normalize = (value: string) => value.trim().toLowerCase();

// Case-insensitive because Salesforce holds both "Advocacy Group" (Type) and "Advocacy group" (Type_2__c).
const BY_SOURCE = new Map<string, PartnerType>(
  (Object.entries(GROUPS) as [PartnerType, readonly string[]][])
    .flatMap(([type, sources]) => sources.map((source) => [normalize(source), type] as const)));

/**
 * The vocabulary value for a raw Type / Type_2__c / Industry string, which may be a ";"-joined
 * multipicklist. '' for a blank, which stays blank for the Untyped worklist. undefined when any
 * part is unknown, so a new Salesforce value is reported rather than guessed at.
 */
export function partnerTypeFor(raw: string): PartnerType | '' | undefined {
  const parts = raw.split(';').map(normalize).filter(Boolean);
  if (parts.length === 0) return '';
  const types = parts.map((part) => BY_SOURCE.get(part));
  if (types.includes(undefined)) return undefined;
  return MOST_SPECIFIC_FIRST.find((type) => types.includes(type));
}
