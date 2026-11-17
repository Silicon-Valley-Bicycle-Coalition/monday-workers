import { dayNumber, pairKey } from '../rule';
import type { Candidate } from '../rule';
import type { AnswerRow } from './store';

// Pure rules for employer answers (design "Proposing it" and "Latest answer only").

const newestFirst = (x: AnswerRow, y: AnswerRow): number =>
  x.answeredAt !== y.answeredAt ? (x.answeredAt < y.answeredAt ? 1 : -1) : x.receivedAt < y.receivedAt ? 1 : x.receivedAt > y.receivedAt ? -1 : 0;

// Expires answers more than `maxAgeDays` old (exactly maxAgeDays is kept), then, per person, keeps
// only the latest answer (ties: latest receivedAt) and any other row with the same normalised text.
export function expireAndSupersede(rows: AnswerRow[], today: string, maxAgeDays: number): {
  live: AnswerRow[]; expired: AnswerRow[]; superseded: AnswerRow[];
} {
  const todayDay = dayNumber(today);
  const expired: AnswerRow[] = [];
  const byPerson = new Map<string, AnswerRow[]>();
  for (const r of rows) {
    if (todayDay - dayNumber(r.answeredAt) > maxAgeDays) { expired.push(r); continue; }
    const list = byPerson.get(r.personItemId);
    if (list === undefined) byPerson.set(r.personItemId, [r]);
    else list.push(r);
  }
  const live: AnswerRow[] = [];
  const superseded: AnswerRow[] = [];
  for (const list of byPerson.values()) {
    const winner = [...list].sort(newestFirst)[0]!;
    for (const r of list) (r.answerNormalized === winner.answerNormalized ? live : superseded).push(r);
  }
  return { live, expired, superseded };
}

// One Current candidate per (person, organization) pair from answers already resolved to an org.
export function answerCandidates(resolved: { row: AnswerRow; orgItemId: string }[]): Candidate[] {
  const byPair = new Map<string, AnswerRow[]>();
  for (const { row, orgItemId } of resolved) {
    const key = pairKey(row.personItemId, orgItemId);
    const list = byPair.get(key);
    if (list === undefined) byPair.set(key, [row]);
    else list.push(row);
  }
  const out: Candidate[] = [];
  for (const rows of byPair.values()) {
    const sorted = [...rows].sort(newestFirst);
    const orgItemId = resolved.find((x) => x.row === sorted[0])!.orgItemId;
    out.push({
      personItemId: sorted[0]!.personItemId, orgItemId, proposedStatus: 'Current',
      latestEvidence: sorted[0]!.answeredAt, matches: [], answers: sorted,
    });
  }
  return out;
}

// Same pair from both sources becomes one candidate: Current if either says so, latest date wins.
export function mergeCandidates(fromMatches: Candidate[], fromAnswers: Candidate[]): Candidate[] {
  const merged = new Map<string, Candidate>();
  for (const c of [...fromMatches, ...fromAnswers]) {
    const key = pairKey(c.personItemId, c.orgItemId);
    const prior = merged.get(key);
    if (prior === undefined) { merged.set(key, { ...c }); continue; }
    merged.set(key, {
      personItemId: c.personItemId,
      orgItemId: c.orgItemId,
      proposedStatus: prior.proposedStatus === 'Current' || c.proposedStatus === 'Current' ? 'Current' : 'Former',
      latestEvidence: prior.latestEvidence >= c.latestEvidence ? prior.latestEvidence : c.latestEvidence,
      matches: [...prior.matches, ...c.matches],
      answers: [...prior.answers, ...c.answers],
    });
  }
  return [...merged.values()];
}
