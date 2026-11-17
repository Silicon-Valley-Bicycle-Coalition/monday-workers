import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../test/reset';
import { pairKey, type MatchRow } from './rule';
import { allMatches, proposedPairs, recordProposal, refreshMatches } from './store';

const NOW = '2026-11-16T11:00:00Z';
const row = (id: string, over: Partial<MatchRow> = {}): MatchRow =>
  ({ donationItemId: id, personItemId: 'p1', orgItemId: 'o1', matchDate: '2026-01-01', amountCents: 1000, ...over });

async function seedBootstrap(rows: MatchRow[]): Promise<void> {
  for (const r of rows) {
    await env.DB.prepare(
      `INSERT INTO matches (donation_item_id, person_item_id, org_item_id, match_date, amount_cents, source, seen_at)
       VALUES (?, ?, ?, ?, ?, 'bootstrap', '2026-11-01T00:00:00Z')`,
    ).bind(r.donationItemId, r.personItemId, r.orgItemId, r.matchDate, r.amountCents).run();
  }
}

const sources = async (): Promise<Record<string, string>> => {
  const { results } = await env.DB.prepare('SELECT donation_item_id, source FROM matches').all<{ donation_item_id: string; source: string }>();
  return Object.fromEntries(results.map((r) => [r.donation_item_id, r.source]));
};

describe('refreshMatches', () => {
  beforeEach(resetDb);

  it("upserts board rows with source 'board', overwriting an existing row's values", async () => {
    await seedBootstrap([row('1')]);
    const result = await refreshMatches(env.DB, { stored: [row('1', { personItemId: 'p9', matchDate: '2026-02-02', amountCents: null })], rejectedIds: [] }, NOW);
    expect(result).toEqual({ upserted: 1, deleted: 0 });
    expect(await allMatches(env.DB)).toEqual([row('1', { personItemId: 'p9', matchDate: '2026-02-02', amountCents: null })]);
    expect(await sources()).toEqual({ '1': 'board' });
  });

  it('deletes rejected ids and keeps rows the board did not return', async () => {
    await seedBootstrap([row('1'), row('2'), row('3')]);
    const result = await refreshMatches(env.DB, { stored: [row('1')], rejectedIds: ['3'] }, NOW);
    expect(result.deleted).toBe(1);
    expect(Object.keys(await sources()).sort()).toEqual(['1', '2']);
  });

  it('round-trips more rows than one D1 batch', async () => {
    const many = Array.from({ length: 250 }, (_, i) => row(String(i + 1)));
    await refreshMatches(env.DB, { stored: many, rejectedIds: [] }, NOW);
    expect(await allMatches(env.DB)).toHaveLength(250);
  });
});

describe('proposals ledger', () => {
  beforeEach(resetDb);

  it('recordProposal then proposedPairs returns the key', async () => {
    await recordProposal(env.DB, { personItemId: 'p1', orgItemId: 'o1', affiliationItemId: 'a1', proposedStatus: 'Former', matchCount: 3 }, NOW);
    expect(await proposedPairs(env.DB)).toEqual(new Set([pairKey('p1', 'o1')]));
  });

  it('records an email-domain proposal with its evidence and domain; a matches one defaults to matches', async () => {
    await recordProposal(env.DB, { personItemId: 'p1', orgItemId: 'o1', affiliationItemId: 'a1', proposedStatus: 'Former', matchCount: 3 }, NOW);
    await recordProposal(env.DB, {
      personItemId: 'p2', orgItemId: 'o1', affiliationItemId: 'a2', proposedStatus: 'Current', matchCount: 0, evidence: 'email_domain', domain: 'acme.example',
    }, NOW);
    const { results } = await env.DB.prepare('SELECT person_item_id, evidence, domain, match_count FROM proposals ORDER BY person_item_id').all();
    expect(results).toEqual([
      { person_item_id: 'p1', evidence: 'matches', domain: null, match_count: 3 },
      { person_item_id: 'p2', evidence: 'email_domain', domain: 'acme.example', match_count: 0 },
    ]);
    expect(await proposedPairs(env.DB)).toEqual(new Set([pairKey('p1', 'o1'), pairKey('p2', 'o1')]));
  });
});

