import type { MatchRow } from './rule';

// The comment posted on each Draft so staff can judge it without leaving the item (spec "What a
// proposal is"): the matches it rests on, newest first, at most 10 lines, and, for a Draft a newer
// employer demoted to Former, which one.
const MAX_LINES = 10;

const dollars = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function evidenceComment(orgName: string, matches: MatchRow[], supersededBy?: { orgName: string; latestMatch: string }): string {
  const lines = matches.slice(0, MAX_LINES).map((m) => `${m.matchDate} ${m.amountCents === null ? '(no amount)' : dollars(m.amountCents)}`);
  if (matches.length > MAX_LINES) lines.push(`and ${matches.length - MAX_LINES} more`);
  if (supersededBy) lines.push(`Proposed as Former: ${supersededBy.orgName} has matched since (latest ${supersededBy.latestMatch}).`);
  return [`Proposed from ${matches.length} matching gifts by ${orgName}:`, ...lines].join('\n');
}
