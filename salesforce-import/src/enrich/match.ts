export type NameConfidence = 'exact' | 'close' | 'weak';

const SUFFIXES = /\b(inc|incorporated|llc|llp|ltd|corp|corporation|co|company|the)\b/g;

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How confident we are that a Places result is the same organization as the
 * Salesforce account. 'exact' auto-accepts; 'close' is flagged for review;
 * 'weak' is reported but never merged.
 */
export function nameConfidence(orgName: string, placeName: string): NameConfidence {
  const a = normalize(orgName);
  const b = normalize(placeName);
  if (a === b) return 'exact';
  if (a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a))) return 'close';
  return 'weak';
}
