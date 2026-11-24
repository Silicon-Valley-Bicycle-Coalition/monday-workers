// Canonical employer-name matching: which Organization a typed name means. Pure, no I/O.
// impact-attribution/src/employerName.ts carries a byte-identical copy (each Worker stays
// self-contained); the employer-name-copies CI job fails on drift. Edit this file, then `cp` it
// over the copy. Must stay strip-only TypeScript (no enums, namespaces, parameter properties).

export interface OrganizationCandidate {
  id: string;
  name: string;
}

const SUFFIX_WORDS = ['inc', 'incorporated', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company'];
const TRAILING_SUFFIX = new RegExp(`,?\\s*\\b(?:${SUFFIX_WORDS.join('|')})\\.?$`, 'i');

// The spellings an Organization item might carry for a stem. Monday's name lookup is exact, so
// these are what let "Google" find "Google, LLC".
const SUFFIX_SPELLINGS = [', LLC', ' LLC', ', Inc.', ' Inc.', ' Inc', ', Inc', ' Corp', ' Corporation', ' Ltd', ' Co'];

// Lower case, letters/digits only (any script), one trailing corporate suffix word dropped, no
// spaces — so "AT&T", "AT & T, Inc." and "at&t inc" all compare equal.
export function normalizeEmployerName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length > 0 && SUFFIX_WORDS.includes(words[words.length - 1]!)) words.pop();
  return words.join('');
}

function stemOf(typed: string): string {
  return typed.trim().replace(TRAILING_SUFFIX, '').trim();
}

// Names to look up on the Organizations board: the typed name, its stem, and the stem with each
// suffix spelling. Empty when nothing matchable is left, so no lookup goes out for "Inc.".
export function organizationNameVariants(typed: string): string[] {
  const trimmed = typed.trim();
  const stem = stemOf(trimmed);
  if (normalizeEmployerName(stem) === '') return [];
  return [...new Set([trimmed, stem, ...SUFFIX_SPELLINGS.map((suffix) => `${stem}${suffix}`)])];
}

export function pickOrganization(
  typed: string,
  candidates: OrganizationCandidate[],
):
  | { kind: 'one'; organization: OrganizationCandidate }
  | { kind: 'none' }
  | { kind: 'several'; organizations: OrganizationCandidate[] } {
  const wanted = normalizeEmployerName(typed);
  if (wanted === '') return { kind: 'none' };
  const matches = candidates.filter((c) => normalizeEmployerName(c.name) === wanted);
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'one', organization: matches[0]! };
  return { kind: 'several', organizations: matches };
}
