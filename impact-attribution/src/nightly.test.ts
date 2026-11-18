import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import production from '../config/svbc.json';
import { resetDb } from '../test/reset';
import { validateConfig } from './config';
import type { AffiliationRecord, OrganizationRecord } from './emailDomains/domains';
import type { PersonRecord } from './emailDomains/select';
import type { ImpactMondayClient } from './monday/client';
import { runNightly } from './nightly';
import { pairKey, type MatchRow } from './rule';
import type { BoardMatchRead } from './store';

const config = validateConfig(production);
const NOW = '2026-11-17T11:00:00Z';
const match = (id: string, matchDate: string): MatchRow => ({ donationItemId: id, personItemId: '1', orgItemId: '501', matchDate, amountCents: 5000 });

// Both jobs against one board-backed fake: Jo has two recent matches by Acme and an Acme address;
// Al has only the address.
class FakeClient implements ImpactMondayClient {
  read: BoardMatchRead = { stored: [match('d1', '2026-10-01'), match('d2', '2026-06-01')], rejectedIds: [] };
  failMatchesRead = false;
  people: PersonRecord[] = [
    { itemId: '1', boardId: config.peopleBoardIds[0]!, name: 'Jo Doe', personalEmail: 'jo@acme.example', householdEmail: null, employerName: null, lastGiftDate: null },
    { itemId: '2', boardId: config.peopleBoardIds[0]!, name: 'Al Roe', personalEmail: 'al@acme.example', householdEmail: null, employerName: null, lastGiftDate: null },
  ];
  organizations: OrganizationRecord[] = [{ itemId: '501', name: 'Acme', websiteUrl: 'https://acme.example' }];
  affiliations: AffiliationRecord[] = [];
  drafts: { personItemId: string; orgItemId: string }[] = [];
  private nextId = 7000;

  async readActiveMatches() {
    if (this.failMatchesRead) throw new Error('monday down');
    return this.read;
  }
  async existingAffiliationPairs() {
    return new Set(this.affiliations.flatMap((a) => a.personIds.flatMap((p) => a.organizationIds.map((o) => pairKey(p, o)))));
  }
  async activeItems(ids: string[]) {
    const names = new Map([...this.people.map((p) => [p.itemId, p.name] as const), ...this.organizations.map((o) => [o.itemId, o.name] as const)]);
    return new Map(ids.filter((id) => names.has(id)).map((id) => [id, names.get(id)!]));
  }
  async findOrganizationsByNames() { return []; } // the employer-answer step (GL#127); no answers here
  async createDraft(_cfg: unknown, d: { name: string; personItemId: string; orgItemId: string }) {
    this.drafts.push({ personItemId: d.personItemId, orgItemId: d.orgItemId });
    const itemId = String(this.nextId++);
    this.affiliations.push({ itemId, personIds: [d.personItemId], organizationIds: [d.orgItemId], status: 'Draft', workEmail: null });
    return itemId;
  }
  async postUpdate() {}
  async listPeople(boardId: string) { return this.people.filter((p) => p.boardId === boardId); }
  async listOrganizations() { return this.organizations; }
  async listAffiliations() { return this.affiliations; }
}

const deps = (monday: ImpactMondayClient) => ({ monday, db: env.DB, config, environment: 'production' as const, today: NOW.slice(0, 10), now: NOW });
const evidence = async () => (await env.DB.prepare('SELECT person_item_id, evidence FROM proposals ORDER BY person_item_id').all()).results;

beforeEach(resetDb);

describe('runNightly', () => {
  it('runs the matching-gift job first, then email domains, and proposes each pair once', async () => {
    const monday = new FakeClient();
    await runNightly(deps(monday), 'on');
    expect(monday.drafts).toEqual([{ personItemId: '1', orgItemId: '501' }, { personItemId: '2', orgItemId: '501' }]);
    expect(await evidence()).toEqual([{ person_item_id: '1', evidence: 'matches' }, { person_item_id: '2', evidence: 'email_domain' }]);
  });

  it('a failing job does not stop the other; the run still fails afterwards', async () => {
    const monday = new FakeClient();
    monday.failMatchesRead = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runNightly(deps(monday), 'on')).rejects.toThrow(/matching-gift proposals failed/);
    } finally {
      err.mockRestore();
    }
    expect(await evidence()).toEqual([{ person_item_id: '1', evidence: 'email_domain' }, { person_item_id: '2', evidence: 'email_domain' }]);
  });
});
