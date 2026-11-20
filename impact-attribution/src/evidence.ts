import type { AnswerRow } from './answers/store';
import type { MatchRow } from './rule';

// The comment posted on each Draft so staff can judge it without leaving the item (spec "What a
// proposal is"): the matches it rests on, newest first, at most 10 lines, and, for a Draft a newer
// employer demoted to Former, which one.
const MAX_LINES = 10;

const dollars = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Monday renders update bodies as HTML, and answers are public free text.
const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// How each answer source reads in the comment; an unknown source (a row from a newer Worker read by
// an older build) falls back to a neutral phrase.
const SOURCE_PHRASES: Record<string, string> = {
  eventbrite: 'an Eventbrite answer',
  funraise: 'the matching-gift company on a Funraise gift',
};
const sourcePhrase = (source: string): string => SOURCE_PHRASES[source] ?? `a ${source} answer`;

export function evidenceComment(
  orgName: string, matches: MatchRow[], answers: AnswerRow[] = [],
  supersededBy?: { orgName: string; latestEvidence: string; source: 'matches' | 'answer' },
): string {
  const out: string[] = [];
  if (matches.length > 0 || answers.length === 0) {
    const lines = matches.slice(0, MAX_LINES).map((m) => `${m.matchDate} ${m.amountCents === null ? '(no amount)' : dollars(m.amountCents)}`);
    if (matches.length > MAX_LINES) lines.push(`and ${matches.length - MAX_LINES} more`);
    out.push(`Proposed from ${matches.length} matching gifts by ${orgName}:`, ...lines);
  }
  if (answers.length > 0) {
    out.push(...answers.slice(0, MAX_LINES).map((a) => `Proposed from ${sourcePhrase(a.source)}: "${escapeHtml(a.answer)}" (${escapeHtml(a.context)}, ${a.answeredAt})`));
    if (answers.length > MAX_LINES) out.push(`and ${answers.length - MAX_LINES} more`);
  }
  if (supersededBy) {
    out.push(supersededBy.source === 'matches'
      ? `Proposed as Former: ${supersededBy.orgName} has matched since (latest ${supersededBy.latestEvidence}).`
      : `Proposed as Former: named ${supersededBy.orgName} as their employer since (latest ${supersededBy.latestEvidence}).`);
  }
  return out.join('\n');
}
