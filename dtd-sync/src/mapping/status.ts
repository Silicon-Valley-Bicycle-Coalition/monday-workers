/**
 * Match Status label for a DTD keyword. A paired gift is always `Matched`; an unknown
 * keyword is `Other` (never an error); no keyword yet means DTD is still identifying the employer.
 */
export function matchStatusLabel(keyword: string | null, labels: Record<string, string>, paired: boolean): string {
  if (paired) return 'Matched';
  if (keyword === null) return 'Identifying employer';
  return labels[keyword] ?? 'Other';
}
