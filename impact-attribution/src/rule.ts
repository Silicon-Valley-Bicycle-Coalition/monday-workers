import type { ImpactAttributionConfig } from './config';

// The pairing rule (spec "The rule"): a person matched by the same organization twice within
// `windowDays` (inclusive) is proposed as affiliated with it — Current if their latest match by it
// is within `currentWithinDays` of today, otherwise Former.

export interface MatchRow { donationItemId: string; personItemId: string; orgItemId: string; matchDate: string; amountCents: number | null }

export interface Candidate {
  personItemId: string;
  orgItemId: string;
  proposedStatus: 'Current' | 'Former';
  latestMatch: string;
  matches: MatchRow[]; // newest first
}

export const pairKey = (personItemId: string, orgItemId: string): string => `${personItemId}:${orgItemId}`;

const DAY_MS = 86_400_000;
const dayNumber = (isoDate: string): number => {
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
      latestMatch: latest.matchDate,
      matches: newestFirst,
    });
  }
  return out;
}

export interface SelectSkips { excludedOrgIds: Set<string>; existingPairs: Set<string>; proposedPairs: Set<string> }

export function selectCandidates(all: Candidate[], skip: SelectSkips, max: number): {
  chosen: Candidate[]; skipped: { excluded: number; existing: number; proposed: number }; deferred: number;
} {
  const skipped = { excluded: 0, existing: 0, proposed: 0 };
  const eligible: Candidate[] = [];
  for (const c of all) {
    const key = pairKey(c.personItemId, c.orgItemId);
    if (skip.excludedOrgIds.has(c.orgItemId)) skipped.excluded++;
    else if (skip.existingPairs.has(key)) skipped.existing++;
    else if (skip.proposedPairs.has(key)) skipped.proposed++;
    else eligible.push(c);
  }
  eligible.sort((x, y) => {
    if (x.proposedStatus !== y.proposedStatus) return x.proposedStatus === 'Current' ? -1 : 1;
    return x.latestMatch < y.latestMatch ? 1 : x.latestMatch > y.latestMatch ? -1 : 0;
  });
  return { chosen: eligible.slice(0, max), skipped, deferred: Math.max(0, eligible.length - max) };
}
