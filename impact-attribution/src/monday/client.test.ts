import { describe, expect, it } from 'vitest';
import { FakeMonday, type FakeItem } from '../../test/fakeMonday';
import { validateConfig, type ImpactAttributionConfig } from '../config';
import { organizationNameVariants, pickOrganization } from '../employerName';
import production from '../../config/svbc.json';
import { HttpMondayClient, parseMatchItem, type RawMatchItem } from './client';

const cfg: ImpactAttributionConfig = validateConfig({
  ...production,
  donations: { ...production.donations, boardId: '200' },
  affiliations: { ...production.affiliations, boardId: '900' },
  peopleBoardIds: ['301', '302'],
  organizationsBoardId: '400',
  emailDomains: { ...production.emailDomains, proposeFromBoardIds: ['301'] },
});

const raw = (over: Partial<RawMatchItem> = {}): RawMatchItem => ({
  id: 'd1', giftType: 'Matching Donation', matchedBy: [{ id: 'o1', boardId: '400' }], donor: [{ id: 'p1', boardId: '301' }],
  date: '2026-03-04', amount: '123.45', ...over,
});

describe('parseMatchItem', () => {
  it('maps a matching gift with a person Donor to a MatchRow', () => {
    expect(parseMatchItem(raw(), cfg)).toEqual({ donationItemId: 'd1', personItemId: 'p1', orgItemId: 'o1', matchDate: '2026-03-04', amountCents: 12345 });
  });

  it('accepts a Donor on People (Historical) and a blank Amount', () => {
    expect(parseMatchItem(raw({ donor: [{ id: 'p2', boardId: '302' }], amount: '' }), cfg)?.amountCents).toBeNull();
  });

  it.each<[string, Partial<RawMatchItem>]>([
    ['another Gift Type', { giftType: 'Donation' }],
    ['no Matched By', { matchedBy: [] }],
    ['two Matched By', { matchedBy: [{ id: 'o1', boardId: '400' }, { id: 'o2', boardId: '400' }] }],
    ['a Matched By off the Organizations board', { matchedBy: [{ id: 'o1', boardId: '999' }] }],
    ['a Donor on Organizations', { donor: [{ id: 'o1', boardId: '400' }] }],
    ['no Donor', { donor: [] }],
    ['two Donors', { donor: [{ id: 'p1', boardId: '301' }, { id: 'p2', boardId: '301' }] }],
    ['no Date', { date: null }],
  ])('returns null for %s', (_label, over) => {
    expect(parseMatchItem(raw(over), cfg)).toBeNull();
  });
});

const DONATION_COLUMNS = [
  { id: 'gt', title: 'Gift Type', type: 'text' },
  { id: 'mb', title: 'Matched By', type: 'board_relation' },
  { id: 'dn', title: 'Donor', type: 'board_relation' },
  { id: 'dt', title: 'Date', type: 'date' },
  { id: 'am', title: 'Amount', type: 'numbers' },
];
const donation = (id: string, giftType: string, donorBoard = '301'): FakeItem => ({
  id, cells: { gt: { text: giftType }, mb: { linked: [{ id: 'o1', board: '400' }] }, dn: { linked: [{ id: 'p1', board: donorBoard }] }, dt: { text: '2026-01-02' }, am: { text: '50' } },
});

const AFF_COLUMNS = [
  { id: 'name', title: 'Name', type: 'name' },
  { id: 'pe', title: 'Person', type: 'board_relation' },
  { id: 'or', title: 'Organization', type: 'board_relation' },
  { id: 'st', title: 'Status', type: 'status' },
  { id: 'ps', title: '🔒 Proposed status', type: 'status' },
];

function fake(): FakeMonday {
  const f = new FakeMonday();
  f.addBoard({ id: '200', columns: DONATION_COLUMNS, items: [] });
  f.addBoard({ id: '900', columns: AFF_COLUMNS, items: [] });
  return f;
}

describe('readActiveMatches', () => {
  it('reads Matched By items only, pages, and splits stored rows from rejected ids', async () => {
    const f = fake();
    f.pageSize = 2;
    f.boards.get('200')!.items = [donation('d1', 'Matching Donation'), donation('d2', 'Donation'), donation('d3', 'Matching Donation', '400'), donation('d4', 'Matching Donation')];
    f.boards.get('200')!.items.push({ id: 'd5', cells: { gt: { text: 'Matching Donation' } } }); // no Matched By: never returned
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });
    const read = await client.readActiveMatches(cfg);
    expect(read.stored.map((m) => m.donationItemId)).toEqual(['d1', 'd4']);
    expect(read.rejectedIds).toEqual(['d2', 'd3']);
    expect(f.queryParams[0]).toEqual({ rules: [{ column_id: 'mb', compare_value: [], operator: 'is_not_empty' }] });
    expect(f.requests.some((r) => r.query.includes('linked_items { id board { id } }'))).toBe(true);
  });
});

describe('existingAffiliationPairs', () => {
  it('returns every person:organization pair on the board, whatever its status', async () => {
    const f = fake();
    f.boards.get('900')!.items = [
      { id: 'a1', cells: { pe: { linked: [{ id: 'p1', board: '301' }] }, or: { linked: [{ id: 'o1', board: '400' }] }, st: { text: 'Former' } } },
      { id: 'a2', cells: { pe: { linked: [{ id: 'p2', board: '302' }] }, or: { linked: [{ id: 'o2', board: '400' }] }, st: { text: 'Draft' } } },
      { id: 'a3', cells: { pe: { linked: [] }, or: { linked: [{ id: 'o3', board: '400' }] } } },
    ];
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });
    expect(await client.existingAffiliationPairs(cfg.affiliations)).toEqual(new Set(['p1:o1', 'p2:o2']));
  });
});

describe('activeItems', () => {
  it('returns names of active items only, asking in chunks of 100', async () => {
    const f = fake();
    f.boards.get('900')!.items = [
      { id: '1', name: 'Pat Doe', cells: {} },
      { id: '2', name: 'Gone', state: 'deleted', cells: {} },
      ...Array.from({ length: 150 }, (_, i) => ({ id: String(100 + i), cells: {} })),
    ];
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });
    const ids = ['1', '2', '3', ...Array.from({ length: 150 }, (_, i) => String(100 + i))];
    const out = await client.activeItems(ids);
    expect(out.get('1')).toBe('Pat Doe');
    expect(out.has('2')).toBe(false);
    expect(out.has('3')).toBe(false);
    expect(out.size).toBe(151);
    expect(f.requests.filter((r) => r.query.includes('items(ids'))).toHaveLength(2);
  });
});

describe('createDraft and postUpdate', () => {
  it('creates a Draft with Proposed status, links, and the given name, resolving marked titles', async () => {
    const f = fake();
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });
    const id = await client.createDraft(cfg.affiliations, { name: 'Pat Doe @ Acme', personItemId: '11', orgItemId: '22', proposedStatus: 'Former' });
    expect(id).toMatch(/^\d+$/);
    expect(f.creates).toEqual([{
      boardId: '900', itemName: 'Pat Doe @ Acme',
      values: { pe: { item_ids: [11] }, or: { item_ids: [22] }, st: { label: 'Draft' }, ps: { label: 'Former' } },
    }]);
  });

  it('posts the update body to the item', async () => {
    const f = fake();
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });
    await client.postUpdate('77', 'hello');
    expect(f.updates).toEqual([{ itemId: '77', body: 'hello' }]);
  });
});

describe('findOrganizationsByNames', () => {
  it('looks names up exactly on the board, 100 values per query, and returns each Organization once', async () => {
    const f = fake();
    f.addBoard({ id: '400', columns: [], items: [
      { id: '1', name: 'Google, LLC', cells: {} },
      { id: '2', name: 'Google', cells: {} },
      { id: '3', name: 'Initech', cells: {} },
    ] });
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });
    const names = ['Google', 'Google, LLC', ...Array.from({ length: 120 }, (_, i) => `Filler ${i}`), 'Initech', 'Google'];
    const found = await client.findOrganizationsByNames('400', names);
    expect(found.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: '1', name: 'Google, LLC' }, { id: '2', name: 'Google' }, { id: '3', name: 'Initech' }]);
    const lookups = f.requests.filter((r) => r.query.includes('items_page_by_column_values'));
    expect(lookups).toHaveLength(2);
    expect(lookups.every((r) => r.variables.boardId === '400' && r.variables.columns[0].column_values.length <= 100)).toBe(true);
  });

  it('follows next_items_page, so a same-name Organization on a later page still makes the answer ambiguous', async () => {
    const f = fake();
    f.pageSize = 1;
    f.addBoard({ id: '400', columns: [], items: [
      { id: '1', name: 'Google, LLC', cells: {} },
      { id: '2', name: 'Google Inc.', cells: {} },
    ] });
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });
    const found = await client.findOrganizationsByNames('400', organizationNameVariants('Google'));
    expect(found.map((o) => o.id).sort()).toEqual(['1', '2']);
    expect(f.requests.filter((r) => r.query.includes('next_items_page'))).toHaveLength(1);
    expect(pickOrganization('Google', found).kind).toBe('several');
  });

  it('sends nothing for no names', async () => {
    const f = fake();
    const client = new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });
    expect(await client.findOrganizationsByNames('400', [])).toEqual([]);
    expect(f.requests).toEqual([]);
  });
});

// Email-domain proposals (GL#124): People, Organizations and Affiliations reads.
describe('email-domain reads', () => {
  const PEOPLE_COLUMNS = [
    { id: 'pe', title: 'Personal Email', type: 'email' },
    { id: 'he', title: 'Household Email', type: 'email' },
    { id: 'en', title: '📜 Employer Name', type: 'text' },
    { id: 'lg', title: '🔒 Last Gift Date', type: 'date' },
  ];
  const AFF_WITH_WORK = [...AFF_COLUMNS, { id: 'we', title: '📜 Work Email', type: 'email' }];

  function domainFake(): FakeMonday {
    const f = fake();
    f.boards.get('900')!.columns = AFF_WITH_WORK;
    f.addBoard({
      id: '301', columns: PEOPLE_COLUMNS,
      items: [
        { id: '1', name: 'Jo Doe', cells: { pe: { email: ' Jo@Acme.Example ', text: 'Jo - jo@acme.example' }, en: { text: 'Acme Inc' }, lg: { date: '2026-10-01', text: 'Oct 1' } } },
        { id: '2', name: 'Al Roe', cells: {} },
      ],
    });
    f.addBoard({
      id: '400', columns: [{ id: 'web', title: 'Website', type: 'link' }],
      items: [{ id: 'o1', name: 'Google', cells: { web: { url: 'https://www.Google.com/about', text: 'Google - https://www.Google.com/about' } } }],
    });
    f.boards.get('900')!.items = [
      { id: 'a1', cells: { pe: { linked: [{ id: '1', board: '301' }] }, or: { linked: [{ id: 'o1', board: '400' }] }, st: { label: 'Current', text: 'Current' }, we: { email: 'JO@google.com' } } },
      { id: 'a2', cells: {} },
    ];
    return f;
  }
  const client = (f: FakeMonday) => new HttpMondayClient('https://x', 'tok', { fetchFn: f.fetchFn });

  it('lists People with lower-cased emails (not the labelled text), gift date, employer and board', async () => {
    expect(await client(domainFake()).listPeople('301', cfg.emailDomains.people)).toEqual([
      { itemId: '1', boardId: '301', name: 'Jo Doe', personalEmail: 'jo@acme.example', householdEmail: null, employerName: 'Acme Inc', lastGiftDate: '2026-10-01' },
      { itemId: '2', boardId: '301', name: 'Al Roe', personalEmail: null, householdEmail: null, employerName: null, lastGiftDate: null },
    ]);
  });

  it("reads an organization's website from the link's url, not its text", async () => {
    expect(await client(domainFake()).listOrganizations('400', 'Website')).toEqual([{ itemId: 'o1', name: 'Google', websiteUrl: 'https://www.Google.com/about' }]);
  });

  it('lists affiliations with status label and Work Email, keeping half-filled ones', async () => {
    expect(await client(domainFake()).listAffiliations(cfg.affiliations, 'Work Email')).toEqual([
      { itemId: 'a1', personIds: ['1'], organizationIds: ['o1'], status: 'Current', workEmail: 'jo@google.com' },
      { itemId: 'a2', personIds: [], organizationIds: [], status: null, workEmail: null },
    ]);
  });

  it('a missing column title throws naming it', async () => {
    await expect(client(domainFake()).listOrganizations('400', 'Homepage')).rejects.toThrow(/Homepage/);
  });

  it('pages through every People item', async () => {
    const f = domainFake();
    f.pageSize = 500;
    f.boards.get('301')!.items = Array.from({ length: 1200 }, (_, i) => ({ id: String(i + 1), cells: {} }));
    expect(await client(f).listPeople('301', cfg.emailDomains.people)).toHaveLength(1200);
  });
});

