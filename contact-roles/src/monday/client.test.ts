import { describe, expect, it } from 'vitest';
import { FakeMonday } from '../../test/fakeMonday';
import { ColumnLookupError, HttpMondayClient } from './client';
import type { BoardRule, ContactRolesConfig } from '../config';

const AFF_BOARD = '900';
const affCfg: ContactRolesConfig['affiliations'] = {
  boardId: AFF_BOARD, rolesColumn: 'SVBC Roles', statusColumn: 'Status', personColumn: 'Person', orgColumn: 'Organization', currentLabel: 'Current',
};
const sponsorships: BoardRule = { name: 'Sponsorships', boardId: '100', orgColumn: 'Organization', contactsColumn: 'Contacts', role: 'Sponsorship', enabled: true };
const donations: BoardRule = { name: 'Donations', boardId: '200', orgColumn: 'Matched By', contactsColumn: 'Contacts', role: 'Donation Matching', sparse: true, enabled: true };
const leads: BoardRule = { name: 'Leads', boardId: '300', orgColumn: 'Organization', contactsColumn: 'Contacts', typeColumn: 'Type', typeRoles: { Sponsorship: 'Sponsorship' }, enabled: true };

function affiliationsFake(): FakeMonday {
  const fake = new FakeMonday();
  fake.addBoard({
    id: AFF_BOARD,
    columns: [
      { id: 'name', title: 'Name', type: 'name' },
      { id: 'br_person', title: '🔒 Person', type: 'board_relation' },
      { id: 'br_org', title: 'Organization', type: 'board_relation' },
      { id: 'st', title: '📜 Status', type: 'status' },
      { id: 'dd_roles', title: 'SVBC Roles', type: 'dropdown', settings: { labels: [{ id: 1, label: 'Sponsorship' }, { id: 2, label: 'Grants' }] } },
      { id: 'dd_proposed', title: 'Proposed Roles', type: 'dropdown' },
    ],
    items: [
      { id: 'a1', cells: { br_person: { linked: ['p1'] }, br_org: { linked: ['o1'] }, st: { text: 'Current' }, dd_roles: { labels: ['Sponsorship', 'Grants'] } } },
      { id: 'a2', cells: { br_person: { linked: ['p2'] }, br_org: { linked: ['o1'] }, st: { text: 'Former' }, dd_roles: { labels: ['Grants'] } } },
      // Proposed only: must never reach Contacts.
      { id: 'a3', cells: { br_person: { linked: ['p3'] }, br_org: { linked: ['o2'] }, st: { text: 'Current' }, dd_proposed: { labels: ['Sponsorship'] } } },
    ],
  });
  return fake;
}

describe('listAffiliations', () => {
  it('maps links to ids and the SVBC Roles dropdown to labels, finding marked column titles', async () => {
    const fake = affiliationsFake();
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: fake.fetchFn });
    const out = await client.listAffiliations(affCfg);
    expect(out).toEqual([
      { id: 'a1', personId: 'p1', orgId: 'o1', status: 'Current', roles: ['Sponsorship', 'Grants'] },
      { id: 'a2', personId: 'p2', orgId: 'o1', status: 'Former', roles: ['Grants'] },
    ]);
  });

  it('never reads Proposed Roles: a proposed-only affiliation is omitted', async () => {
    const fake = affiliationsFake();
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: fake.fetchFn });
    const out = await client.listAffiliations(affCfg);
    expect(out.find((a) => a.id === 'a3')).toBeUndefined();
    expect(fake.requestedColumns.flat()).not.toContain('dd_proposed');
  });

  it('names the title and board when a column is missing', async () => {
    const fake = affiliationsFake();
    fake.boards.get(AFF_BOARD)!.columns = fake.boards.get(AFF_BOARD)!.columns.filter((c) => c.id !== 'dd_roles');
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: fake.fetchFn });
    const err = await client.listAffiliations(affCfg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColumnLookupError);
    expect((err as Error).message).toContain('SVBC Roles');
    expect((err as Error).message).toContain(AFF_BOARD);
  });
});

describe('roleLabels', () => {
  it('returns the dropdown labels of SVBC Roles', async () => {
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: affiliationsFake().fetchFn });
    expect(await client.roleLabels(affCfg)).toEqual(['Sponsorship', 'Grants']);
  });

  it('throws the typed missing-column error when SVBC Roles does not exist yet', async () => {
    const fake = affiliationsFake();
    fake.boards.get(AFF_BOARD)!.columns = fake.boards.get(AFF_BOARD)!.columns.filter((c) => c.id !== 'dd_roles');
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: fake.fetchFn });
    await expect(client.roleLabels(affCfg)).rejects.toBeInstanceOf(ColumnLookupError);
  });
});

describe('listBoardItems', () => {
  function boardsFake(): FakeMonday {
    const fake = new FakeMonday();
    fake.addBoard({
      id: '100',
      columns: [
        { id: 'name', title: 'Name', type: 'name' },
        { id: 'br_org', title: 'Organization', type: 'board_relation' },
        { id: 'br_con', title: '🔒 Contacts', type: 'board_relation' },
      ],
      items: ['s1', 's2', 's3'].map((id, n) => ({ id, cells: { br_org: { linked: [`o${n}`, 'oX'] }, br_con: { linked: n === 0 ? ['p1', 'p2'] : [] } } })),
    });
    fake.addBoard({
      id: '200',
      columns: [
        { id: 'br_mb', title: 'Matched By', type: 'board_relation' },
        { id: 'br_con', title: 'Contacts', type: 'board_relation' },
      ],
      items: [
        { id: 'd1', cells: { br_mb: { linked: ['o1'] } } },
        { id: 'd2', cells: { br_mb: { linked: [] } } },
        { id: 'd4', cells: { br_mb: { linked: [] }, br_con: { linked: ['p7'] } } },
        { id: 'd3', cells: { br_mb: { linked: ['o2'] }, br_con: { linked: ['p9'] } } },
      ],
    });
    fake.addBoard({
      id: '300',
      columns: [
        { id: 'br_org', title: 'Organization', type: 'board_relation' },
        { id: 'br_con', title: 'Contacts', type: 'board_relation' },
        { id: 'st_type', title: 'Type', type: 'status' },
      ],
      items: [{ id: 'l1', cells: { br_org: { linked: ['o1'] }, st_type: { text: 'Sponsorship' } } }, { id: 'l2', cells: { br_org: { linked: ['o1'] } } }],
    });
    return fake;
  }

  it('pages through a cursor and maps orgs and current contacts', async () => {
    const fake = boardsFake();
    fake.pageSize = 2;
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: fake.fetchFn });
    const items = await client.listBoardItems(sponsorships);
    expect(items).toEqual([
      { id: 's1', orgIds: ['o0', 'oX'], typeLabel: null, currentPersonIds: ['p1', 'p2'] },
      { id: 's2', orgIds: ['o1', 'oX'], typeLabel: null, currentPersonIds: [] },
      { id: 's3', orgIds: ['o2', 'oX'], typeLabel: null, currentPersonIds: [] },
    ]);
    expect(fake.queryParams).toEqual([null]);
    expect(fake.requestedColumns.length).toBe(2);
  });

  it('on a sparse rule reads items with Matched By or Contacts set, not the whole board', async () => {
    const fake = boardsFake();
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: fake.fetchFn });
    const items = await client.listBoardItems(donations);
    // d4 had Matched By cleared but still carries Contacts: returned so it can be cleared. d2 has neither.
    expect(items.map((i) => i.id)).toEqual(['d1', 'd4', 'd3']);
    expect(items.find((i) => i.id === 'd4')).toEqual({ id: 'd4', orgIds: [], typeLabel: null, currentPersonIds: ['p7'] });
    expect(items.at(-1)).toEqual({ id: 'd3', orgIds: ['o2'], typeLabel: null, currentPersonIds: ['p9'] });
  });

  it('reads the Type label for a typeColumn rule', async () => {
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: boardsFake().fetchFn });
    const items = await client.listBoardItems(leads);
    expect(items.map((i) => i.typeLabel)).toEqual(['Sponsorship', null]);
  });

  it('throws a typed error naming the board when Contacts does not exist yet', async () => {
    const fake = boardsFake();
    fake.boards.get('200')!.columns = fake.boards.get('200')!.columns.filter((c) => c.id !== 'br_con');
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: fake.fetchFn });
    const err = await client.listBoardItems(donations).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ColumnLookupError);
    expect((err as Error).message).toContain('Contacts');
    expect((err as Error).message).toContain('200');
  });
});

describe('setContacts', () => {
  const fake = () => {
    const f = new FakeMonday();
    f.addBoard({ id: '100', columns: [{ id: 'br_org', title: 'Organization', type: 'board_relation' }, { id: 'br_con', title: '🔒 Contacts', type: 'board_relation' }], items: [] });
    return f;
  };

  it('writes connect-boards item_ids as numbers to the resolved column', async () => {
    const f = fake();
    await new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn }).setContacts(sponsorships, 's1', ['11', '12']);
    expect(f.writes).toEqual([{ boardId: '100', itemId: 's1', values: { br_con: { item_ids: [11, 12] } } }]);
  });

  it('clears the column with an empty list', async () => {
    const f = fake();
    await new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn }).setContacts(sponsorships, 's1', []);
    expect(f.writes[0]!.values).toEqual({ br_con: { item_ids: [] } });
  });

  it('rejects a non-numeric person id before writing', async () => {
    const f = fake();
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });
    await expect(client.setContacts(sponsorships, 's1', ['11', 'abc'])).rejects.toThrow(/not numeric/);
    await expect(client.setContacts(sponsorships, 's1', ['99999999999999999999'])).rejects.toThrow(/not numeric/);
    expect(f.writes).toEqual([]);
  });
});
