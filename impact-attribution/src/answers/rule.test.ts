import { describe, expect, it } from 'vitest';
import { answerCandidates, expireAndSupersede, mergeCandidates } from './rule';
import type { AnswerRow } from './store';
import type { Candidate } from '../rule';

const ans = (over: Partial<AnswerRow>): AnswerRow => ({
  source: 'eventbrite', sourceId: 'a', personItemId: 'p', answer: 'Google', answerNormalized: 'google',
  answeredAt: '2026-11-01', context: 'Ride', state: 'pending', orgItemId: null, receivedAt: '2026-11-01T00:00:00Z', ...over,
});

describe('expireAndSupersede', () => {
  it('expires an answer more than maxAgeDays old and keeps exactly maxAgeDays', () => {
    const old = ans({ sourceId: 'old', answeredAt: '2025-11-16' }); // 366 days before 2026-11-17
    const edge = ans({ sourceId: 'edge', answeredAt: '2025-11-17', personItemId: 'q' }); // 365
    const r = expireAndSupersede([old, edge], '2026-11-17', 365);
    expect(r.expired.map((x) => x.sourceId)).toEqual(['old']);
    expect(r.live.map((x) => x.sourceId)).toEqual(['edge']);
    expect(r.superseded).toEqual([]);
  });

  it('keeps only the latest answer per person', () => {
    const g = ans({ sourceId: 'g', answer: 'Google', answerNormalized: 'google', answeredAt: '2026-03-01' });
    const a = ans({ sourceId: 'a', answer: 'Apple', answerNormalized: 'apple', answeredAt: '2026-10-01' });
    const r = expireAndSupersede([g, a], '2026-11-17', 365);
    expect(r.live.map((x) => x.sourceId)).toEqual(['a']);
    expect(r.superseded.map((x) => x.sourceId)).toEqual(['g']);
  });

  it('breaks same-day ties by latest receivedAt', () => {
    const x = ans({ sourceId: 'x', answerNormalized: 'x', receivedAt: '2026-11-01T01:00:00Z' });
    const y = ans({ sourceId: 'y', answerNormalized: 'y', receivedAt: '2026-11-01T02:00:00Z' });
    const r = expireAndSupersede([x, y], '2026-11-17', 365);
    expect(r.live.map((v) => v.sourceId)).toEqual(['y']);
    expect(r.superseded.map((v) => v.sourceId)).toEqual(['x']);
  });

  it('keeps every row that normalises like the winner', () => {
    const a = ans({ sourceId: 'a', answeredAt: '2026-05-01' });
    const b = ans({ sourceId: 'b', answeredAt: '2026-06-01', answer: 'GOOGLE' });
    const r = expireAndSupersede([a, b], '2026-11-17', 365);
    expect(r.live.map((v) => v.sourceId).sort()).toEqual(['a', 'b']);
    expect(r.superseded).toEqual([]);
  });

  it('treats people independently', () => {
    const r = expireAndSupersede([ans({ sourceId: 'a', personItemId: 'p' }), ans({ sourceId: 'b', personItemId: 'q', answerNormalized: 'apple' })], '2026-11-17', 365);
    expect(r.live).toHaveLength(2);
  });

  it('expires first, then supersedes among the rest', () => {
    const old = ans({ sourceId: 'old', answeredAt: '2024-01-01', answerNormalized: 'old' });
    const cur = ans({ sourceId: 'cur', answeredAt: '2026-01-01' });
    const r = expireAndSupersede([old, cur], '2026-11-17', 365);
    expect(r.expired.map((v) => v.sourceId)).toEqual(['old']);
    expect(r.superseded).toEqual([]);
    expect(r.live.map((v) => v.sourceId)).toEqual(['cur']);
  });
});

describe('answerCandidates', () => {
  it('groups answers per pair as Current, newest first', () => {
    const a1 = ans({ sourceId: '1', answeredAt: '2026-05-01' });
    const a2 = ans({ sourceId: '2', answeredAt: '2026-08-01' });
    const out = answerCandidates([{ row: a1, orgItemId: '9' }, { row: a2, orgItemId: '9' }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ personItemId: 'p', orgItemId: '9', proposedStatus: 'Current', latestEvidence: '2026-08-01', matches: [] });
    expect(out[0]!.answers.map((r) => r.sourceId)).toEqual(['2', '1']);
  });
});

describe('mergeCandidates', () => {
  const base = (p: string, o: string, s: 'Current' | 'Former', latest: string): Candidate =>
    ({ personItemId: p, orgItemId: o, proposedStatus: s, latestEvidence: latest, matches: [], answers: [] });

  it('merges the same pair: Current wins and the later date is kept', () => {
    const m = { ...base('p', '9', 'Former', '2024-01-01'), matches: [{ donationItemId: 'd', personItemId: 'p', orgItemId: '9', matchDate: '2024-01-01', amountCents: 1 }] };
    const a = { ...base('p', '9', 'Current', '2026-08-01'), answers: [ans({})] };
    const out = mergeCandidates([m], [a]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ proposedStatus: 'Current', latestEvidence: '2026-08-01' });
    expect(out[0]!.matches).toHaveLength(1);
    expect(out[0]!.answers).toHaveLength(1);
  });

  it('concatenates non-overlapping lists', () => {
    const out = mergeCandidates([base('p', '1', 'Former', '2024-01-01')], [base('q', '2', 'Current', '2026-01-01')]);
    expect(out.map((c) => c.orgItemId)).toEqual(['1', '2']);
  });
});
