import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../test/reset';
import production from '../config/svbc.json';
import { validateConfig } from './config';
import type { ImpactMondayClient } from './monday/client';
import { pairKey, type MatchRow } from './rule';
import { runProposals } from './run';
import type { BoardMatchRead } from './store';

const config = validateConfig(production);
const TODAY = '2026-11-16';
const NOW = '2026-11-16T11:00:00Z';
const PERSON_NAME = 'Pat Quincy-Doe';

const match = (id: string, personItemId: string, orgItemId: string, matchDate: string): MatchRow =>
  ({ donationItemId: id, personItemId, orgItemId, matchDate, amountCents: 10000 });

class FakeClient implements ImpactMondayClient {
  read: BoardMatchRead = { stored: [], rejectedIds: [] };
  existing = new Set<string>();
  names = new Map<string, string>();
  drafts: { name: string; personItemId: string; orgItemId: string; proposedStatus: string }[] = [];
  updates: { itemId: string; body: string }[] = [];
  failCreateFor = new Set<string>();
  failUpdate = false;
  private next = 1;

  async readActiveMatches(): Promise<BoardMatchRead> { return this.read; }
  async existingAffiliationPairs(): Promise<Set<string>> { return this.existing; }
  async activeItems(ids: string[]): Promise<Map<string, string>> {
    return new Map(ids.filter((id) => this.names.has(id)).map((id) => [id, this.names.get(id)!]));
  }
  async createDraft(_cfg: unknown, d: { name: string; personItemId: string; orgItemId: string; proposedStatus: 'Current' | 'Former' }): Promise<string> {
    if (this.failCreateFor.has(d.personItemId)) throw new Error('monday API: boom');
    this.drafts.push(d);
    return `a${this.next++}`;
  }
  async postUpdate(itemId: string, body: string): Promise<void> {
    if (this.failUpdate) throw new Error('monday API: update failed');
    this.updates.push({ itemId, body });
  }
  // The email-domain job's reads (#124); never called by this job.
  async listPeople(): Promise<never> { throw new Error('not this job'); }
  async listOrganizations(): Promise<never> { throw new Error('not this job'); }
  async listAffiliations(): Promise<never> { throw new Error('not this job'); }
}

function clientWith(matches: MatchRow[]): FakeClient {
  const c = new FakeClient();
  c.read = { stored: matches, rejectedIds: [] };
  c.names = new Map([['p1', PERSON_NAME], ['p2', 'Sam Roe'], ['o1', 'Acme Corp'], ['o2', 'Globex']]);
  return c;
}

const deps = (monday: FakeClient, cfg = config) => ({ monday, db: env.DB, config: cfg, environment: 'production' as const, today: TODAY, now: NOW });
const proposalRows = async () => (await env.DB.prepare('SELECT person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count FROM proposals ORDER BY person_item_id').all()).results;

let logs: string[] = [];
beforeEach(async () => {
  await resetDb();
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterEach(() => vi.restoreAllMocks());

describe('runProposals (on)', () => {
  it('creates a Draft named "<person> @ <org>", records the proposal, and posts the evidence', async () => {
    const monday = clientWith([match('d1', 'p1', 'o1', '2026-03-01'), match('d2', 'p1', 'o1', '2026-09-01')]);
    const summary = await runProposals(deps(monday), 'on');
    expect(monday.drafts).toEqual([{ name: `${PERSON_NAME} @ Acme Corp`, personItemId: 'p1', orgItemId: 'o1', proposedStatus: 'Current' }]);
    expect(await proposalRows()).toEqual([{ person_item_id: 'p1', org_item_id: 'o1', affiliation_item_id: 'a1', proposed_status: 'Current', match_count: 2 }]);
    expect(monday.updates).toEqual([{ itemId: 'a1', body: 'Proposed from 2 matching gifts by Acme Corp:\n2026-09-01 $100.00\n2026-03-01 $100.00' }]);
    expect(summary).toMatchObject({ matchesRead: 2, qualifying: 1, proposed: 1, failed: 0, deferred: 0 });
  });

  it('proposes the older of two employers as Former and says which one superseded it', async () => {
    const monday = clientWith([
      match('d1', 'p1', 'o1', '2026-02-01'), match('d2', 'p1', 'o1', '2026-03-01'),
      match('d3', 'p1', 'o2', '2026-08-01'), match('d4', 'p1', 'o2', '2026-09-01'),
    ]);
    monday.existing = new Set([pairKey('p1', 'o2')]); // staff already have the newer employer
    await runProposals(deps(monday), 'on');
    expect(monday.drafts).toEqual([{ name: `${PERSON_NAME} @ Acme Corp`, personItemId: 'p1', orgItemId: 'o1', proposedStatus: 'Former' }]);
    expect(monday.updates[0]!.body).toContain('Proposed as Former: Globex has matched since (latest 2026-09-01).');
  });

  it('judges pairs from the stored history, not only from what the board returns', async () => {
    await env.DB.prepare(
      `INSERT INTO matches (donation_item_id, person_item_id, org_item_id, match_date, amount_cents, source, seen_at)
       VALUES ('old', 'p1', 'o1', '2015-02-01', NULL, 'bootstrap', ?)`,
    ).bind(NOW).run();
    const monday = clientWith([match('d1', 'p1', 'o1', '2015-06-01')]);
    await runProposals(deps(monday), 'on');
    expect(monday.drafts.map((d) => d.proposedStatus)).toEqual(['Former']);
  });

  it('skips a pair that already has an Affiliation, and one already proposed', async () => {
    await env.DB.prepare(
      `INSERT INTO proposals (person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count, proposed_at)
       VALUES ('p2', 'o2', 'a0', 'Current', 2, ?)`,
    ).bind(NOW).run();
    const monday = clientWith([
      match('d1', 'p1', 'o1', '2026-03-01'), match('d2', 'p1', 'o1', '2026-04-01'),
      match('d3', 'p2', 'o2', '2026-03-01'), match('d4', 'p2', 'o2', '2026-04-01'),
    ]);
    monday.existing = new Set([pairKey('p1', 'o1')]);
    const summary = await runProposals(deps(monday), 'on');
    expect(monday.drafts).toEqual([]);
    expect(summary.skipped).toMatchObject({ existing: 1, proposed: 1 });
  });

  it('skips an excluded payer', async () => {
    const monday = clientWith([match('d1', 'p1', 'o1', '2026-03-01'), match('d2', 'p1', 'o1', '2026-04-01')]);
    const summary = await runProposals(deps(monday, { ...config, excludedPayers: [{ id: 'o1', note: 'Acme Foundation' }] }), 'on');
    expect(monday.drafts).toEqual([]);
    expect(summary.skipped.excluded).toBe(1);
  });

  it('skips a candidate whose person or organization item is gone', async () => {
    const monday = clientWith([match('d1', 'p9', 'o1', '2026-03-01'), match('d2', 'p9', 'o1', '2026-04-01')]);
    const summary = await runProposals(deps(monday), 'on');
    expect(monday.drafts).toEqual([]);
    expect(summary.skipped.missingItem).toBe(1);
    expect(await proposalRows()).toEqual([]);
  });

  it('a failed create records nothing and the next candidate is still proposed', async () => {
    const monday = clientWith([
      match('d1', 'p1', 'o1', '2026-09-01'), match('d2', 'p1', 'o1', '2026-10-01'),
      match('d3', 'p2', 'o2', '2026-03-01'), match('d4', 'p2', 'o2', '2026-04-01'),
    ]);
    monday.failCreateFor = new Set(['p1']);
    const summary = await runProposals(deps(monday), 'on');
    expect(monday.drafts.map((d) => d.personItemId)).toEqual(['p2']);
    expect((await proposalRows()).map((r) => r.person_item_id)).toEqual(['p2']);
    expect(summary).toMatchObject({ proposed: 1, failed: 1 });
    expect(logs.some((l) => l.includes('impact-attribution: proposal p1/o1 failed'))).toBe(true);
  });

  it('a failed comment still records the proposal, and the run continues', async () => {
    const monday = clientWith([
      match('d1', 'p1', 'o1', '2026-09-01'), match('d2', 'p1', 'o1', '2026-10-01'),
      match('d3', 'p2', 'o2', '2026-03-01'), match('d4', 'p2', 'o2', '2026-04-01'),
    ]);
    monday.failUpdate = true;
    const summary = await runProposals(deps(monday), 'on');
    expect((await proposalRows()).map((r) => r.person_item_id)).toEqual(['p1', 'p2']);
    expect(summary).toMatchObject({ proposed: 2, failed: 0 });
  });

  it('a gone candidate does not take a capped slot: the next live one is proposed', async () => {
    // p9 sorts first (newest Current) but its person item is gone; with a cap of 1 the live p2
    // must still be proposed, or a stale pair would block the queue every night.
    const monday = clientWith([
      match('d1', 'p9', 'o1', '2026-10-01'), match('d2', 'p9', 'o1', '2026-10-15'),
      match('d3', 'p2', 'o2', '2026-03-01'), match('d4', 'p2', 'o2', '2026-04-01'),
    ]);
    const summary = await runProposals(deps(monday, { ...config, maxProposalsPerRun: 1 }), 'on');
    expect(monday.drafts.map((d) => d.personItemId)).toEqual(['p2']);
    expect(summary).toMatchObject({ proposed: 1, deferred: 0, skipped: { missingItem: 1 } });
  });

  it('deletes a stored match the board no longer returns when its item is still active (Matched By cleared)', async () => {
    await env.DB.prepare(
      `INSERT INTO matches (donation_item_id, person_item_id, org_item_id, match_date, amount_cents, source, seen_at)
       VALUES ('d8', 'p1', 'o1', '2026-02-01', NULL, 'board', ?), ('d9', 'p1', 'o1', '2026-02-02', NULL, 'board', ?)`,
    ).bind(NOW, NOW).run();
    const monday = clientWith([match('d1', 'p1', 'o1', '2026-03-01')]);
    monday.names.set('d8', 'active gift, Matched By cleared'); // d9 is archived: not active
    const summary = await runProposals(deps(monday), 'off');
    const ids = (await env.DB.prepare('SELECT donation_item_id FROM matches ORDER BY donation_item_id').all<{ donation_item_id: string }>()).results.map((r) => r.donation_item_id);
    expect(ids).toEqual(['d1', 'd9']);
    expect(summary.deleted).toBe(1);
  });

  it('caps the run at maxProposalsPerRun and counts the rest as deferred', async () => {
    const monday = clientWith([
      match('d1', 'p1', 'o1', '2026-09-01'), match('d2', 'p1', 'o1', '2026-10-01'),
      match('d3', 'p2', 'o2', '2026-03-01'), match('d4', 'p2', 'o2', '2026-04-01'),
    ]);
    const summary = await runProposals(deps(monday, { ...config, maxProposalsPerRun: 1 }), 'on');
    expect(monday.drafts.map((d) => d.personItemId)).toEqual(['p1']);
    expect(summary.deferred).toBe(1);
  });

  it('never logs a person name', async () => {
    const monday = clientWith([match('d1', 'p1', 'o1', '2026-03-01'), match('d2', 'p1', 'o1', '2026-09-01')]);
    monday.failUpdate = true;
    await runProposals(deps(monday), 'on');
    await runProposals(deps(clientWith([match('d1', 'p1', 'o1', '2026-03-01'), match('d2', 'p1', 'o1', '2026-09-01')])), 'off');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(PERSON_NAME);
  });
});

describe('runProposals (off)', () => {
  it('refreshes matches but writes nothing to Monday or the ledger, and logs the payer summary', async () => {
    const monday = clientWith([match('d1', 'p1', 'o1', '2026-03-01'), match('d2', 'p1', 'o1', '2026-09-01')]);
    const summary = await runProposals(deps(monday), 'off');
    expect(monday.drafts).toEqual([]);
    expect(monday.updates).toEqual([]);
    expect(await proposalRows()).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM matches').first<{ n: number }>())?.n).toBe(2);
    expect(summary.proposed).toBe(0);
    const line = logs.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).find((l) => l?.mode === 'off');
    expect(line?.payers).toEqual([{ orgItemId: 'o1', orgName: 'Acme Corp', wouldPropose: 1 }]);
  });
});
