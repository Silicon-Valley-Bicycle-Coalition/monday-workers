import type { AnswerRow } from './answers/store';
import type { MatchRow } from './rule';

// The comment posted on each Draft so staff can judge it without leaving the item (spec "What a
// proposal is"): the matches it rests on, newest first, at most 10 lines.
const MAX_LINES = 10;

const dollars = (cents: number): string =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function evidenceComment(orgName: string, matches: MatchRow[], answers: AnswerRow[] = []): string {
  const out: string[] = [];
  if (matches.length > 0 || answers.length === 0) {
    const lines = matches.slice(0, MAX_LINES).map((m) => `${m.matchDate} ${m.amountCents === null ? '(no amount)' : dollars(m.amountCents)}`);
    if (matches.length > MAX_LINES) lines.push(`and ${matches.length - MAX_LINES} more`);
    out.push(`Proposed from ${matches.length} matching gifts by ${orgName}:`, ...lines);
  }
  if (answers.length > 0) {
    out.push(...answers.slice(0, MAX_LINES).map((a) => `Proposed from an Eventbrite answer: "${a.answer}" (${a.context}, ${a.answeredAt})`));
    if (answers.length > MAX_LINES) out.push(`and ${answers.length - MAX_LINES} more`);
  }
  return out.join('\n');
}
