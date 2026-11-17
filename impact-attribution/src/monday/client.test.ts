import { describe, expect, it } from 'vitest';
import { FakeMonday, type FakeItem } from '../../test/fakeMonday';
import { validateConfig, type ImpactAttributionConfig } from '../config';
import production from '../../config/svbc.json';
import { HttpMondayClient, parseMatchItem, type RawMatchItem } from './client';

const cfg: ImpactAttributionConfig = validateConfig({
  ...production,
  donations: { ...production.donations, boardId: '200' },
  affiliations: { ...production.affiliations, boardId: '900' },
  peopleBoardIds: ['301', '302'],
  organizationsBoardId: '400',
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
