// Pure rules for a donor's own employer answer (spec 2026-11-16-donor-employer-answer-design.md):
// which Organization a typed name means, and which affiliation writes make it the donor's
// Current, Primary one. No I/O here; applyEmployer.ts does the Monday calls.

export interface OrganizationCandidate {
  id: string;
  name: string;
}

export interface AffiliationRecord {
  id: string;
  organizationId: string | null;
  organizationName: string | null;
  statusLabel: string | null;
  primary: boolean;
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

export type AffiliationPlan =
  | { kind: 'noChange' }
  | { kind: 'apply'; reuseAffiliationId: string | null; clearPrimaryOn: AffiliationRecord[] };

// Primary moves to the matched Organization's affiliation (reused if one exists, the Current one
// first). Every other Primary loses only Primary: Status on another affiliation never changes.
export function planAffiliationChange(
  affiliations: AffiliationRecord[],
  organizationId: string,
  currentStatusLabel: string,
): AffiliationPlan {
  const mine = affiliations.filter((a) => a.organizationId === organizationId);
  const reuse = mine.find((a) => a.statusLabel === currentStatusLabel) ?? mine[0] ?? null;
  const clearPrimaryOn = affiliations.filter((a) => a.primary && a.organizationId !== organizationId);
  const alreadyDone = reuse !== null && reuse.statusLabel === currentStatusLabel && reuse.primary;
  if (alreadyDone && clearPrimaryOn.length === 0) return { kind: 'noChange' };
  return { kind: 'apply', reuseAffiliationId: reuse?.id ?? null, clearPrimaryOn };
}

export function previousPrimaryNote(clearPrimaryOn: AffiliationRecord[]): string {
  if (clearPrimaryOn.length === 0) return '';
  const names = clearPrimaryOn.map((a) => a.organizationName ?? '(no Organization)').join(', ');
  return ` (previous Primary: ${names}, still Current)`;
}
