import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb } from '../test/reset';
import production from '../config/svbc.json';
import { validateConfig } from './config';
import { setAnswerStates, upsertAnswer } from './answers/store';
import { normalizeEmployerName, type OrganizationCandidate } from './employerName';
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
  orgs: OrganizationCandidate[] = [];
  orgLookups: { boardId: string; names: string[] }[] = [];
  private next = 1;

  async findOrganizationsByNames(boardId: string, names: string[]): Promise<OrganizationCandidate[]> {
    this.orgLookups.push({ boardId, names });
    return this.orgs.filter((o) => names.includes(o.name));
  }

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

const answer = (sourceId: string, personItemId: string, text: string, answeredAt = '2026-11-01', context = 'Bike Fest') =>
  upsertAnswer(env.DB, {
    source: 'eventbrite', sourceId, personItemId, answer: text, answerNormalized: normalizeEmployerName(text), answeredAt, context, receivedAt: NOW,
  });
interface AnswerDbRow { source_id: string; state: string; org_item_id: string | null; last_tried_at: string | null }
const answerRows = async (): Promise<Record<string, AnswerDbRow>> => Object.fromEntries(
  (await env.DB.prepare('SELECT source_id, state, org_item_id, last_tried_at FROM employer_answers').all<AnswerDbRow>()).results.map((r) => [r.source_id, r]),
);
const sourcesOf = async () => (await env.DB.prepare('SELECT person_item_id, sources FROM proposals ORDER BY person_item_id').all()).results;
const ZERO_ANSWERS = { pending: 0, expired: 0, superseded: 0, resolved: 0, unresolved: 0, skipped: 0, proposed: 0 };

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

describe('runProposals: employer answers', () => {
  const withOrgs = (orgs: OrganizationCandidate[], matches: MatchRow[] = []): FakeClient => {
    const c = clientWith(matches);
    c.orgs = orgs;
    for (const o of orgs) c.names.set(o.id, o.name);
    return c;
  };

  it('does not run the answer step without employerAnswers config', async () => {
    await answer('a1', 'p1', 'Google');
    const monday = withOrgs([{ id: 'o5', name: 'Google, LLC' }]);
    const summary = await runProposals(deps(monday, { ...config, employerAnswers: undefined }), 'on');
    expect(monday.orgLookups).toEqual([]);
    expect(monday.drafts).toEqual([]);
    expect(summary.answers).toEqual(ZERO_ANSWERS);
    expect((await answerRows()).a1).toMatchObject({ state: 'pending', last_tried_at: null });
  });

  it('proposes a Current Draft from a resolved answer and records it as answers-only', async () => {
    await answer('a1', 'p1', 'Google');
    const monday = withOrgs([{ id: 'o5', name: 'Google, LLC' }]);
    const summary = await runProposals(deps(monday), 'on');
    expect(monday.orgLookups).toHaveLength(1);
    expect(monday.orgLookups[0]!.boardId).toBe(config.organizationsBoardId);
    expect(monday.orgLookups[0]!.names).toContain('Google, LLC');
    expect(monday.drafts).toEqual([{ name: `${PERSON_NAME} @ Google, LLC`, personItemId: 'p1', orgItemId: 'o5', proposedStatus: 'Current' }]);
    expect(await proposalRows()).toEqual([{ person_item_id: 'p1', org_item_id: 'o5', affiliation_item_id: 'a1', proposed_status: 'Current', match_count: 0 }]);
    expect(await sourcesOf()).toEqual([{ person_item_id: 'p1', sources: 'answers' }]);
    expect((await answerRows()).a1).toMatchObject({ state: 'proposed', org_item_id: 'o5', last_tried_at: NOW });
    expect(monday.updates).toEqual([{ itemId: 'a1', body: 'Proposed from an Eventbrite answer: "Google" (Bike Fest, 2026-11-01)' }]);
    expect(summary.answers).toEqual({ ...ZERO_ANSWERS, resolved: 1, proposed: 1 });
  });

  it('leaves an unresolved answer pending, then proposes it once the Organization exists', async () => {
    await answer('a1', 'p1', 'Acme');
    const first = withOrgs([]);
    const s1 = await runProposals(deps(first), 'on');
    expect(first.drafts).toEqual([]);
    expect((await answerRows()).a1).toMatchObject({ state: 'pending', last_tried_at: NOW });
    expect(s1.answers).toEqual({ ...ZERO_ANSWERS, pending: 1, unresolved: 1 });

    const second = withOrgs([{ id: 'o7', name: 'Acme' }]);
    await runProposals({ ...deps(second), now: '2026-11-17T11:00:00Z' }, 'on');
    expect(second.drafts.map((d) => [d.personItemId, d.orgItemId])).toEqual([['p1', 'o7']]);
    expect((await answerRows()).a1).toMatchObject({ state: 'proposed', org_item_id: 'o7' });
  });

  it('leaves an answer pending when two Organizations normalise equal', async () => {
    await answer('a1', 'p1', 'Google');
    const monday = withOrgs([{ id: 'o5', name: 'Google, LLC' }, { id: 'o6', name: 'Google Inc.' }]);
    const summary = await runProposals(deps(monday), 'on');
    expect(monday.drafts).toEqual([]);
    expect((await answerRows()).a1).toMatchObject({ state: 'pending', last_tried_at: NOW });
    expect(summary.answers.unresolved).toBe(1);
  });

  it('marks skipped an answer whose pair is excluded, already affiliated or already proposed', async () => {
    await answer('ax', 'p1', 'Foundation');
    await answer('ae', 'p2', 'Globex');
    await answer('ap', 'p3', 'Initech');
    await env.DB.prepare(
      `INSERT INTO proposals (person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count, proposed_at)
       VALUES ('p3', 'o8', 'a0', 'Current', 2, ?)`,
    ).bind(NOW).run();
    const monday = withOrgs([{ id: 'o9', name: 'Foundation' }, { id: 'o2', name: 'Globex' }, { id: 'o8', name: 'Initech' }]);
    monday.names.set('p3', 'Chris Poe');
    monday.existing = new Set([pairKey('p2', 'o2')]);
    const summary = await runProposals(deps(monday, { ...config, excludedPayers: [{ id: 'o9', note: 'A foundation' }] }), 'on');
    expect(monday.drafts).toEqual([]);
    const rows = await answerRows();
    expect([rows.ax!.state, rows.ae!.state, rows.ap!.state]).toEqual(['skipped', 'skipped', 'skipped']);
    expect(summary.answers).toEqual({ ...ZERO_ANSWERS, resolved: 3, skipped: 3 });
    expect(summary.skipped).toMatchObject({ excluded: 1, existing: 1, proposed: 1 });
  });

  it('marks skipped an answer whose person item is gone, without using a capped slot', async () => {
    await answer('a9', 'p9', 'Google', '2026-11-10');
    await answer('a2', 'p2', 'Google', '2026-11-01');
    const monday = withOrgs([{ id: 'o5', name: 'Google, LLC' }]);
    const summary = await runProposals(deps(monday, { ...config, maxProposalsPerRun: 1 }), 'on');
    expect(monday.drafts.map((d) => d.personItemId)).toEqual(['p2']);
    const rows = await answerRows();
    expect(rows.a9!.state).toBe('skipped');
    expect(rows.a2!.state).toBe('proposed');
    expect(summary.skipped.missingItem).toBe(1);
    expect(summary.answers).toMatchObject({ skipped: 1, proposed: 1 });
  });

  it('merges a pair with match and answer evidence into one Current Draft with both kinds of lines', async () => {
    await answer('a1', 'p1', 'Acme Corp');
    const monday = withOrgs([{ id: 'o1', name: 'Acme Corp' }], [match('d1', 'p1', 'o1', '2015-03-01'), match('d2', 'p1', 'o1', '2015-06-01')]);
    await runProposals(deps(monday), 'on');
    expect(monday.drafts).toEqual([{ name: `${PERSON_NAME} @ Acme Corp`, personItemId: 'p1', orgItemId: 'o1', proposedStatus: 'Current' }]);
    expect(await sourcesOf()).toEqual([{ person_item_id: 'p1', sources: 'both' }]);
    expect((await proposalRows())[0]).toMatchObject({ match_count: 2 });
    expect(monday.updates[0]!.body).toBe(
      'Proposed from 2 matching gifts by Acme Corp:\n2015-06-01 $100.00\n2015-03-01 $100.00\n'
      + 'Proposed from an Eventbrite answer: "Acme Corp" (Bike Fest, 2026-11-01)',
    );
    expect((await answerRows()).a1).toMatchObject({ state: 'proposed', org_item_id: 'o1' });
  });

  it('shares maxProposalsPerRun: Current answers first, the rest deferred and their answers still pending', async () => {
    await answer('a1', 'p1', 'Google', '2026-11-01');
    await answer('a3', 'p3', 'Initech', '2026-10-01');
    const monday = withOrgs([{ id: 'o5', name: 'Google, LLC' }, { id: 'o6', name: 'Initech' }],
      [match('d3', 'p2', 'o2', '2015-03-01'), match('d4', 'p2', 'o2', '2015-04-01')]);
    monday.names.set('p3', 'Chris Poe');
    const summary = await runProposals(deps(monday, { ...config, maxProposalsPerRun: 1 }), 'on');
    expect(monday.drafts.map((d) => d.personItemId)).toEqual(['p1']);
    expect(summary.deferred).toBe(2);
    const rows = await answerRows();
    expect(rows.a1!.state).toBe('proposed');
    expect(rows.a3).toMatchObject({ state: 'pending', last_tried_at: NOW });
    expect(summary.answers).toEqual({ ...ZERO_ANSWERS, pending: 1, resolved: 2, proposed: 1 });
  });

  it('leaves the answer pending when the Draft create fails', async () => {
    await answer('a1', 'p1', 'Google');
    const monday = withOrgs([{ id: 'o5', name: 'Google, LLC' }]);
    monday.failCreateFor = new Set(['p1']);
    const summary = await runProposals(deps(monday), 'on');
    expect(await proposalRows()).toEqual([]);
    expect((await answerRows()).a1).toMatchObject({ state: 'pending', last_tried_at: NOW });
    expect(summary).toMatchObject({ failed: 1, answers: { pending: 1, proposed: 0 } });
  });

  it('supersedes a late-arriving answer older than the person\'s latest proposed one instead of proposing it', async () => {
    await answer('new', 'p1', 'Google', '2027-02-01');
    await setAnswerStates(env.DB, [{ source: 'eventbrite', sourceId: 'new', state: 'proposed', orgItemId: 'o5' }], NOW);
    await answer('backfill', 'p1', 'Initech', '2026-10-01');
    const monday = withOrgs([{ id: 'o5', name: 'Google, LLC' }, { id: 'o6', name: 'Initech' }]);
    const summary = await runProposals({ ...deps(monday), today: '2027-02-02' }, 'on');
    expect(monday.drafts).toEqual([]);
    expect((await answerRows()).backfill!.state).toBe('superseded');
    expect(summary.answers).toEqual({ ...ZERO_ANSWERS, superseded: 1 });
  });

  it('a failing answer step is logged without answer text and the match proposals still run', async () => {
    await answer('a1', 'p2', 'Secretco Widgets');
    const monday = withOrgs([], [match('d1', 'p1', 'o1', '2026-03-01'), match('d2', 'p1', 'o1', '2026-09-01')]);
    monday.findOrganizationsByNames = async () => { throw new TypeError('lookup exploded'); };
    const summary = await runProposals(deps(monday), 'on');
    expect(monday.drafts.map((d) => [d.personItemId, d.orgItemId])).toEqual([['p1', 'o1']]);
    expect(summary.answers).toEqual(ZERO_ANSWERS);
    expect(logs).toContain('impact-attribution: answer step failed: TypeError: lookup exploded');
    expect(logs.join('\n')).not.toContain('Secretco');
    expect((await answerRows()).a1!.state).toBe('pending');
  });

  it('under off: writes nothing to Monday or the ledger, still updates answer states, and logs no answer text', async () => {
    await answer('old', 'p4', 'Oldco Widgets', '2025-01-01', 'Secret Ride 2025'); // > 365 days: expired
    await answer('s1', 'p5', 'Umbrella Pharma', '2026-03-01'); // superseded by p5's later answer
    await answer('s2', 'p5', 'Initech Inc', '2026-09-01');
    await answer('sk', 'p2', 'Globex'); // existing pair: skipped
    await answer('un', 'p1', 'Nowhere Holdings'); // unresolved
    const monday = withOrgs([{ id: 'o6', name: 'Initech' }, { id: 'o2', name: 'Globex' }]);
    monday.names.set('p5', 'Robin Moe');
    monday.existing = new Set([pairKey('p2', 'o2')]);
    const summary = await runProposals(deps(monday), 'off');
    expect(monday.drafts).toEqual([]);
    expect(monday.updates).toEqual([]);
    expect(await proposalRows()).toEqual([]);
    const rows = await answerRows();
    expect(Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, r.state]))).toEqual({
      old: 'expired', s1: 'superseded', s2: 'pending', sk: 'skipped', un: 'pending',
    });
    expect(rows.s2!.last_tried_at).toBe(NOW);
    expect(rows.un!.last_tried_at).toBe(NOW);
    expect(summary.answers).toEqual({ pending: 2, expired: 1, superseded: 1, resolved: 2, unresolved: 1, skipped: 1, proposed: 0 });
    const line = logs.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).find((l) => l?.mode === 'off');
    expect(line?.wouldPropose).toEqual([{ personItemId: 'p5', orgItemId: 'o6', proposedStatus: 'Current', matches: 0, answers: 1 }]);
    const all = logs.join('\n');
    for (const text of ['Oldco Widgets', 'Secret Ride 2025', 'Umbrella Pharma', 'Initech Inc', 'Nowhere Holdings', 'Bike Fest']) expect(all).not.toContain(text);
  });
});
