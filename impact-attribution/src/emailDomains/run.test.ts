import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import production from '../../config/svbc.json';
import { resetDb } from '../../test/reset';
import { validateConfig, type ImpactAttributionConfig } from '../config';
import type { ImpactMondayClient } from '../monday/client';
import type { BoardMatchRead } from '../store';
import { recordProposal } from '../store';
import type { AffiliationRecord, OrganizationRecord } from './domains';
import { runEmailDomainProposals } from './run';
import type { PersonRecord } from './select';

const config: ImpactAttributionConfig = validateConfig(production);
const LIVE = config.peopleBoardIds[0]!;
const NOW = '2026-11-17T11:00:00Z';

// A board-backed fake: a created Draft shows up on the next run's Affiliations read, as on Monday.
class FakeClient implements ImpactMondayClient {
  people: PersonRecord[] = [];
  organizations: OrganizationRecord[] = [{ itemId: '501', name: 'Acme', websiteUrl: 'https://acme.example' }];
  affiliations: AffiliationRecord[] = [];
  drafts: { name: string; personItemId: string; orgItemId: string; proposedStatus: string }[] = [];
  updates: { itemId: string; body: string }[] = [];
  failCreate = false;
  failUpdate = false;
  private nextId = 7000;

  async listPeople(boardId: string) { return this.people.filter((p) => p.boardId === boardId); }
  async listOrganizations() { return this.organizations; }
  async listAffiliations() { return this.affiliations; }
  async createDraft(_cfg: unknown, d: { name: string; personItemId: string; orgItemId: string; proposedStatus: 'Current' | 'Former' }) {
    if (this.failCreate) throw new Error('monday down');
    this.drafts.push(d);
    const itemId = String(this.nextId++);
    this.affiliations.push({ itemId, personIds: [d.personItemId], organizationIds: [d.orgItemId], status: 'Draft', workEmail: null });
    return itemId;
  }
  async postUpdate(itemId: string, body: string) {
    if (this.failUpdate) throw new Error('monday down');
    this.updates.push({ itemId, body });
  }
  // The matching-gift job's reads; never called by this step.
  async readActiveMatches(): Promise<BoardMatchRead> { throw new Error('not this step'); }
  async existingAffiliationPairs(): Promise<Set<string>> { throw new Error('not this step'); }
  async activeItems(): Promise<Map<string, string>> { throw new Error('not this step'); }
}

const person = (itemId: string, name: string, email: string): PersonRecord => ({
  itemId, boardId: LIVE, name, personalEmail: email, householdEmail: null, employerName: null, lastGiftDate: null,
});

function setup(): FakeClient {
  const monday = new FakeClient();
  monday.people = [person('1', 'Jo Doe', 'jo@acme.example'), person('2', 'Al Roe', 'al@acme.example')];
  return monday;
}

const deps = (monday: ImpactMondayClient, db: D1Database = env.DB) =>
  ({ monday, db, config, environment: 'production' as const, today: NOW.slice(0, 10), now: NOW });

const ledger = async () => (await env.DB.prepare(
  'SELECT person_item_id, org_item_id, affiliation_item_id, proposed_status, match_count, evidence, domain FROM proposals ORDER BY person_item_id',
).all<Record<string, unknown>>()).results;
const indexCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM email_index').first<{ n: number }>())!.n;

beforeEach(resetDb);

describe('runEmailDomainProposals', () => {
  it('on: creates Current-proposed Drafts with an evidence comment, records them; a second run creates nothing', async () => {
    const monday = setup();
    const summary = await runEmailDomainProposals(deps(monday), 'on');
    expect(monday.drafts).toEqual([
      { name: 'Jo Doe @ Acme', personItemId: '1', orgItemId: '501', proposedStatus: 'Current' },
      { name: 'Al Roe @ Acme', personItemId: '2', orgItemId: '501', proposedStatus: 'Current' },
    ]);
    expect(monday.updates).toEqual([
      { itemId: '7000', body: 'Proposed from email domain acme.example (Personal Email; Website match).' },
      { itemId: '7001', body: 'Proposed from email domain acme.example (Personal Email; Website match).' },
    ]);
    expect(summary).toMatchObject({ mode: 'on', people: 2, proposed: 2, wouldPropose: 0, failed: 0, deferred: 0 });
    expect(await ledger()).toEqual([
      { person_item_id: '1', org_item_id: '501', affiliation_item_id: '7000', proposed_status: 'Current', match_count: 0, evidence: 'email_domain', domain: 'acme.example' },
      { person_item_id: '2', org_item_id: '501', affiliation_item_id: '7001', proposed_status: 'Current', match_count: 0, evidence: 'email_domain', domain: 'acme.example' },
    ]);

    await runEmailDomainProposals(deps(monday), 'on');
    expect(monday.drafts).toHaveLength(2);
  });

  it('skips a pair the matching-gift job already proposed (one shared ledger)', async () => {
    const monday = setup();
    monday.people = [monday.people[0]!];
    await recordProposal(env.DB, { personItemId: '1', orgItemId: '501', affiliationItemId: 'a1', proposedStatus: 'Current', matchCount: 2 }, NOW);
    const summary = await runEmailDomainProposals(deps(monday), 'on');
    expect(monday.drafts).toEqual([]);
    expect(summary.skipped.alreadyProposed).toBe(1);
  });

  it('off: counts what it would propose, writes nothing to Monday or the ledger, still rebuilds the index', async () => {
    const monday = setup();
    const summary = await runEmailDomainProposals(deps(monday), 'off');
    expect(summary).toMatchObject({ mode: 'off', wouldPropose: 2, proposed: 0 });
    expect(monday.drafts).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await indexCount()).toBe(2);
  });

  it('a failed create is not recorded and is proposed again next run', async () => {
    const monday = setup();
    monday.people = [monday.people[0]!];
    monday.failCreate = true;
    expect((await runEmailDomainProposals(deps(monday), 'on')).failed).toBe(1);
    expect(await ledger()).toEqual([]);

    monday.failCreate = false;
    await runEmailDomainProposals(deps(monday), 'on');
    expect(monday.drafts).toHaveLength(1);
  });

  it('a failed comment does not undo the proposal', async () => {
    const monday = setup();
    monday.people = [monday.people[0]!];
    monday.failUpdate = true;
    const summary = await runEmailDomainProposals(deps(monday), 'on');
    expect(summary).toMatchObject({ proposed: 1, failed: 0 });
    expect(await ledger()).toHaveLength(1);
  });

  it('a ledger write that fails after a create does not lead to a second Draft', async () => {
    const monday = setup();
    monday.people = [monday.people[0]!];
    const brokenDb = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('INSERT INTO proposals')) throw new Error('d1 down');
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    await runEmailDomainProposals(deps(monday, brokenDb), 'on');
    expect(monday.drafts).toHaveLength(1);

    await runEmailDomainProposals(deps(monday), 'on');
    expect(monday.drafts).toHaveLength(1);
  });

  it('off: logs each proposed domain with its organization and source, and each ambiguous domain', async () => {
    const monday = setup();
    monday.organizations.push({ itemId: '601', name: 'Twin A', websiteUrl: 'https://twin.example' }, { itemId: '602', name: 'Twin B', websiteUrl: 'twin.example' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runEmailDomainProposals(deps(monday), 'off');
      const lines = log.mock.calls.map((c) => JSON.parse(String(c[0])));
      expect(lines.find((l) => l.operation === 'emailDomainProposalDomains')).toEqual({
        worker: 'impact-attribution', environment: 'production', operation: 'emailDomainProposalDomains', mode: 'off',
        proposedDomains: [{ domain: 'acme.example', organizationId: '501', source: 'Website match', proposals: 2 }],
        ambiguousDomains: ['twin.example'],
      });
    } finally {
      log.mockRestore();
    }
  });

  it('aborts before any write when no People come back', async () => {
    const monday = setup();
    await env.DB.prepare("INSERT INTO email_index VALUES ('keep@x.example', 'personal', '[\"9\"]', NULL)").run();
    monday.people = [];
    await expect(runEmailDomainProposals(deps(monday), 'on')).rejects.toThrow(/no People/);
    expect(monday.drafts).toEqual([]);
    expect(await indexCount()).toBe(1);
  });

  it('aborts when no Organizations come back', async () => {
    const monday = setup();
    monday.organizations = [];
    await expect(runEmailDomainProposals(deps(monday), 'on')).rejects.toThrow(/no Organizations/);
  });

  it('does not re-propose a Draft that staff deleted or set to Former', async () => {
    const monday = setup();
    await runEmailDomainProposals(deps(monday), 'on');
    monday.affiliations = monday.affiliations
      .filter((a) => a.personIds[0] !== '1') // Jo's Draft deleted
      .map((a) => ({ ...a, status: 'Former' })); // Al's set to Former
    await runEmailDomainProposals(deps(monday), 'on');
    expect(monday.drafts).toHaveLength(2);
  });

  it('logs counts and domains, never an address or a name', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runEmailDomainProposals(deps(setup()), 'on');
      const out = log.mock.calls.flat().map(String).join('\n');
      expect(out).not.toMatch(/@|Jo Doe|Al Roe/);
      expect(out).toContain('"proposed":2');
    } finally {
      log.mockRestore();
    }
  });
});
