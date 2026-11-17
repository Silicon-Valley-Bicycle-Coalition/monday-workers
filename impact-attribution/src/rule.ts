import type { AnswerRow } from './answers/store';
import type { ImpactAttributionConfig } from './config';

// The pairing rule (spec "The rule"): a person matched by the same organization twice within
// `windowDays` (inclusive) is proposed as affiliated with it — Current if their latest match by it
// is within `currentWithinDays` of today, otherwise Former.

export interface MatchRow { donationItemId: string; personItemId: string; orgItemId: string; matchDate: string; amountCents: number | null }

export interface Candidate {
  personItemId: string;
  orgItemId: string;
  proposedStatus: 'Current' | 'Former';
  latestEvidence: string; // latest of the match dates and answer dates
  matches: MatchRow[]; // newest first
  answers: AnswerRow[]; // newest first
}

export const pairKey = (personItemId: string, orgItemId: string): string => `${personItemId}:${orgItemId}`;

const DAY_MS = 86_400_000;
export const dayNumber = (isoDate: string): number => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!) / DAY_MS;
};

export function qualifyingPairs(matches: MatchRow[], rule: ImpactAttributionConfig['rule'], today: string): Candidate[] {
  const byPair = new Map<string, MatchRow[]>();
  for (const m of matches) {
    const key = pairKey(m.personItemId, m.orgItemId);
    const list = byPair.get(key);
    if (list === undefined) byPair.set(key, [m]);
    else list.push(m);
  }
  const todayDay = dayNumber(today);
  const out: Candidate[] = [];
  for (const rows of byPair.values()) {
    if (rows.length < rule.minMatches) continue;
    const newestFirst = [...rows].sort((x, y) => (x.matchDate < y.matchDate ? 1 : x.matchDate > y.matchDate ? -1 : 0));
    const days = newestFirst.map((r) => dayNumber(r.matchDate));
    const qualifies = days.some((d, i) => i > 0 && days[i - 1]! - d <= rule.windowDays);
    if (!qualifies) continue;
    const latest = newestFirst[0]!;
    out.push({
      personItemId: latest.personItemId,
      orgItemId: latest.orgItemId,
      proposedStatus: todayDay - days[0]! <= rule.currentWithinDays ? 'Current' : 'Former',
      latestEvidence: latest.matchDate,
      matches: newestFirst,
      answers: [],
    });
  }
  return out;
}

export interface SelectSkips { excludedOrgIds: Set<string>; existingPairs: Set<string>; proposedPairs: Set<string> }

export type SkipReason = 'excluded' | 'existing' | 'proposed';

// `skippedCandidates` lets the caller close the answers behind a skipped pair; `skipped` counts them.
export function selectCandidates(all: Candidate[], skip: SelectSkips, max: number): {
  chosen: Candidate[]; skipped: Record<SkipReason, number>; skippedCandidates: Record<SkipReason, Candidate[]>; deferred: number;
} {
  const skippedCandidates: Record<SkipReason, Candidate[]> = { excluded: [], existing: [], proposed: [] };
  const eligible: Candidate[] = [];
  for (const c of all) {
    const key = pairKey(c.personItemId, c.orgItemId);
    if (skip.excludedOrgIds.has(c.orgItemId)) skippedCandidates.excluded.push(c);
    else if (skip.existingPairs.has(key)) skippedCandidates.existing.push(c);
    else if (skip.proposedPairs.has(key)) skippedCandidates.proposed.push(c);
    else eligible.push(c);
  }
  const skipped = {
    excluded: skippedCandidates.excluded.length, existing: skippedCandidates.existing.length, proposed: skippedCandidates.proposed.length,
  };
  eligible.sort((x, y) => {
    if (x.proposedStatus !== y.proposedStatus) return x.proposedStatus === 'Current' ? -1 : 1;
    return x.latestEvidence < y.latestEvidence ? 1 : x.latestEvidence > y.latestEvidence ? -1 : 0;
  });
  return { chosen: eligible.slice(0, max), skipped, skippedCandidates, deferred: Math.max(0, eligible.length - max) };
}
