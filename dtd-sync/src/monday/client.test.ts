import { describe, it, expect, vi } from 'vitest';
import { HttpDtdMondayClient, personName, splitName } from './client';
import { validateConfig } from '../config';
import sandbox from '../../config/sandbox.json';

const config = validateConfig(sandbox);
const D = config.donations;
const P = config.people;
const S = config.programSummary;

interface Call { query: string; variables: Record<string, any> }

function mondayFetch(responses: unknown[]) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Call);
    const next = responses.shift();
    return new Response(JSON.stringify({ data: next }), { status: 200 });
  });
  const client = new HttpDtdMondayClient('https://api.example.org/v2', 'test-token', config, {
    fetchFn: fetchFn as unknown as typeof fetch, maxAttempts: 1,
  });
  return { client, calls };
}

function cv(id: string, text: string | null, extra: Record<string, unknown> = {}) {
  return { id, text, value: null, ...extra };
}

function donationItem(id: string, over: Record<string, unknown> = {}) {
  const base: Record<string, any> = {
    [D.amount]: cv(D.amount, '1,250.50'),
    [D.date]: cv(D.date, '2026-10-30'),
    [D.status]: cv(D.status, 'Received', { value: '{"index":1}' }),
    [D.giftType]: cv(D.giftType, 'One-time'),
    [D.funraiseId]: cv(D.funraiseId, '12345', { value: '{"url":"https://x.example.org/12345","text":"12345"}' }),
    [D.salesforceId]: cv(D.salesforceId, ''),
    [D.benevityTransactionId]: cv(D.benevityTransactionId, ''),
    [D.anonymousDonor]: cv(D.anonymousDonor, 'v', { value: '{"checked":"true"}' }),
    [D.donor]: cv(D.donor, 'Pat', { linked_item_ids: ['111'] }),
    [D.matchedBy]: cv(D.matchedBy, '', { linked_item_ids: [] }),
    [D.matchesGift]: cv(D.matchesGift, '', { linked_item_ids: ['222'] }),
    [D.matchPairing]: cv(D.matchPairing, 'Paired', { value: '{"index":2}' }),
    [D.matchStatus]: cv(D.matchStatus, 'Pending', { value: null }),
    [D.sentToDtd]: cv(D.sentToDtd, '2026-10-31'),
  };
  return {
    id, updated_at: '2026-11-01T00:00:00Z', state: 'active', board: { id: String(config.boards.donations) },
    column_values: Object.values({ ...base, ...over }),
  };
}

describe('personName', () => {
  it('uses the stored names as they are', () => {
    expect(personName('Mary', 'Van Der Berg', 'Mary Van Der Berg')).toEqual({ firstName: 'Mary', lastName: 'Van Der Berg' });
  });
  it('keeps a blank Last Name blank when First Name is stored', () => {
    expect(personName('Cher', null, 'Cher')).toEqual({ firstName: 'Cher', lastName: '' });
  });
  it('guesses from the item name when First Name is blank, even with a Last Name', () => {
    expect(personName(null, 'Smith', 'Smith')).toEqual({ firstName: 'Smith', lastName: '' });
  });
  it('treats a First Name of only spaces as blank', () => {
    expect(personName('  ', 'Example', 'Pat Example')).toEqual({ firstName: 'Pat', lastName: 'Example' });
  });
});

describe('splitName', () => {
  it('last token is the last name, the rest the first name', () => {
    expect(splitName('Pat Q Example')).toEqual({ firstName: 'Pat Q', lastName: 'Example' });
  });
  it('tolerates extra whitespace', () => {
    expect(splitName('  Pat   Example  ')).toEqual({ firstName: 'Pat', lastName: 'Example' });
  });
  it('a single word is the first name', () => {
    expect(splitName('Pat')).toEqual({ firstName: 'Pat', lastName: '' });
  });
  it('empty is empty', () => {
    expect(splitName('   ')).toEqual({ firstName: '', lastName: '' });
  });
});

describe('HttpDtdMondayClient donation lookups', () => {
  it('findDonationByFunraiseId queries items_page_by_column_values with the bare id', async () => {
    const { client, calls } = mondayFetch([{ items_page_by_column_values: { items: [donationItem('9')] } }]);
    const d = await client.findDonationByFunraiseId('12345');
    expect(d?.id).toBe('9');
    expect(calls[0]!.query).toContain('items_page_by_column_values');
    expect(calls[0]!.variables.boardId).toBe(config.boards.donations);
    expect(calls[0]!.variables.columns).toEqual([{ column_id: D.funraiseId, column_values: ['12345'] }]);
  });

  it('findDonationBySalesforceId looks up the plain text column; null when none', async () => {
    const { client, calls } = mondayFetch([{ items_page_by_column_values: { items: [] } }]);
    expect(await client.findDonationBySalesforceId('003EXAMPLE')).toBeNull();
    expect(calls[0]!.variables.columns).toEqual([{ column_id: D.salesforceId, column_values: ['003EXAMPLE'] }]);
  });

  it('parses status by label text and connect columns by linked item id', async () => {
    const { client } = mondayFetch([{ items_page_by_column_values: { items: [donationItem('9')] } }]);
    const d = (await client.findDonationByFunraiseId('12345'))!;
    expect(d).toMatchObject({
      id: '9', amount: 1250.5, date: '2026-10-30', status: 'Received', giftType: 'One-time',
      funraiseId: '12345', salesforceId: null, benevityTransactionId: null, anonymous: true,
      donorItemId: '111', matchedByItemId: null, matchesGiftItemId: '222', matchPairing: 'Paired',
      sentToDtd: '2026-10-31', updatedAt: '2026-11-01T00:00:00Z',
    });
  });

  it('an empty status cell (label id 5 text, no stored index) reads as null', async () => {
    const empty = donationItem('9', { [D.matchStatus]: cv(D.matchStatus, 'Stuck', { value: null }), [D.status]: cv(D.status, 'Stuck', { value: null }) });
    const { client } = mondayFetch([{ items_page_by_column_values: { items: [empty] } }]);
    const d = (await client.findDonationByFunraiseId('1'))!;
    expect(d.status).toBeNull();
    expect(d.matchStatus).toBeNull();
  });

  it('getDonation reads by item id; null for a missing or deleted item', async () => {
    const { client, calls } = mondayFetch([{ items: [donationItem('9')] }, { items: [] }, { items: [{ ...donationItem('8'), state: 'deleted' }] }]);
    expect((await client.getDonation('9'))?.id).toBe('9');
    expect(calls[0]!.variables.ids).toEqual(['9']);
    expect(await client.getDonation('7')).toBeNull();
    expect(await client.getDonation('8')).toBeNull();
  });

  it('getDonation asks for the board and returns null for an item on another board', async () => {
    const elsewhere = { ...donationItem('6'), board: { id: String(config.boards.people) } };
    const { client, calls } = mondayFetch([{ items: [elsewhere] }]);
    expect(await client.getDonation('6')).toBeNull();
    expect(calls[0]!.query).toContain('board { id }');
  });

  it('listDonationsDatedSince follows cursors', async () => {
    const { client, calls } = mondayFetch([
      { boards: [{ items_page: { cursor: 'c1', items: [donationItem('1')] } }] },
      { next_items_page: { cursor: 'c2', items: [donationItem('2')] } },
      { next_items_page: { cursor: null, items: [donationItem('3')] } },
    ]);
    const all = await client.listDonationsDatedSince('2026-10-01');
    expect(all.map((d) => d.id)).toEqual(['1', '2', '3']);
    expect(calls[0]!.variables.since).toEqual(['EXACT', '2026-10-01']);
    expect(calls[0]!.query).toContain('$since: CompareValue!');
    expect(calls[1]!.variables.cursor).toBe('c1');
    expect(calls[2]!.variables.cursor).toBe('c2');
  });

  it('listDonationsOfTypeDatedSince adds a Gift Type rule to the query and re-checks the exact type', async () => {
    const other = donationItem('1', { [D.giftType]: cv(D.giftType, 'Matching Donation Pledge') });
    const match = donationItem('2', { [D.giftType]: cv(D.giftType, 'Matching Donation') });
    const { client, calls } = mondayFetch([{ boards: [{ items_page: { cursor: null, items: [other, match] } }] }]);
    const out = await client.listDonationsOfTypeDatedSince('Matching Donation', '2026-10-01');
    expect(out.map((d) => d.id)).toEqual(['2']);
    expect(calls[0]!.query).toContain(`column_id: "${D.giftType}"`);
    expect(calls[0]!.query).toContain('contains_text');
    expect(calls[0]!.variables.giftType).toBe('Matching Donation');
  });

  it('getDonations reads 100 ids to a call, dedupes, and drops deleted or off-board items', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const off = { ...donationItem('2'), board: { id: '1' } };
    const gone = { ...donationItem('3'), state: 'deleted' };
    const { client, calls } = mondayFetch([
      { items: [donationItem('1'), off, gone] },
      { items: [donationItem('101')] },
    ]);
    const out = await client.getDonations([...ids, '1']);
    expect(out.map((d) => d.id)).toEqual(['1', '101']);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.variables.ids).toHaveLength(100);
    expect(calls[1]!.variables.ids).toHaveLength(50);
  });

  it('listDonationsDatedSince drops items dated before the cutoff or undated', async () => {
    const old = donationItem('1', { [D.date]: cv(D.date, '2026-09-30') });
    const undated = donationItem('2', { [D.date]: cv(D.date, '') });
    const { client } = mondayFetch([{ boards: [{ items_page: { cursor: null, items: [old, undated, donationItem('3')] } }] }]);
    expect((await client.listDonationsDatedSince('2026-10-01')).map((d) => d.id)).toEqual(['3']);
  });

  it('listGiftsForDonor filters on the donor connect column, numeric id, and the date floor', async () => {
    const old = donationItem('1', { [D.date]: cv(D.date, '2020-01-01') });
    const { client, calls } = mondayFetch([{ boards: [{ items_page: { cursor: null, items: [old, donationItem('2')] } }] }]);
    const gifts = await client.listGiftsForDonor('111', '2026-01-01');
    expect(gifts.map((g) => g.id)).toEqual(['2']);
    expect(calls[0]!.query).toContain(`column_id: "${D.donor}"`);
    expect(calls[0]!.variables.donorItemId).toBe(111);
  });
});

describe('deleted items', () => {
  it('paged and by-column reads drop deleted items but keep archived ones', async () => {
    const gone = { ...donationItem('1'), state: 'deleted' };
    const archived = { ...donationItem('2'), state: 'archived' };
    const { client } = mondayFetch([
      { boards: [{ items_page: { cursor: null, items: [gone, archived] } }] },
      { items_page_by_column_values: { items: [gone] } },
    ]);
    expect((await client.listDonationsDatedSince('2026-10-01')).map((d) => d.id)).toEqual(['2']);
    expect(await client.findDonationByFunraiseId('12345')).toBeNull();
  });

  it('by-column lookups skip a deleted item ahead of a live one and ask for limit 100', async () => {
    const gone = { ...donationItem('1'), state: 'deleted' };
    const { client, calls } = mondayFetch([
      { items_page_by_column_values: { items: [gone, donationItem('2')] } },
      { items_page_by_column_values: { items: [gone, donationItem('3')] } },
      { items_page_by_column_values: { items: [{ id: '8', state: 'deleted' }, { id: '9', state: 'active' }] } },
      { change_multiple_column_values: { id: '9' } },
      { items_page_by_column_values: { items: [{ id: '8', state: 'deleted' }] } },
      { create_item: { id: '10' } },
    ]);
    expect((await client.findDonationByFunraiseId('12345'))?.id).toBe('2');
    expect((await client.findDonationBySalesforceId('003EXAMPLE'))?.id).toBe('3');
    await client.upsertProgramSummary('FY2026', { [S.screened]: 1 });
    expect(calls[3]!.variables.itemId).toBe('9');
    await client.upsertProgramSummary('FY2026', { [S.screened]: 2 });
    expect(calls[5]!.query).toContain('create_item');
    for (const i of [0, 1, 2, 4]) expect(calls[i]!.query).toContain('limit: 100');
  });

  it('getPeople drops a deleted person', async () => {
    const { client } = mondayFetch([{ items: [
      { id: '1', name: 'Pat Example', state: 'deleted', board: { id: String(config.boards.people) }, column_values: [] },
      { id: '2', name: 'Sam Lee', state: 'active', board: { id: String(config.boards.people) }, column_values: [] },
    ] }]);
    expect((await client.getPeople(['1', '2'])).map((p) => p.id)).toEqual(['2']);
  });
});

describe('HttpDtdMondayClient people and organizations', () => {
  const person = (id: string, name: string, email: string, household: string) => ({
    id, name, board: { id: String(config.boards.people) }, column_values: [
      cv(P.email, email), cv(P.householdEmail, household), cv(P.phone, '+15551230000'), cv(P.dtdCompanyId, 'co_1'),
    ],
  });

  it('getPeople splits the name and prefers the personal email', async () => {
    const { client, calls } = mondayFetch([{ items: [person('1', 'Pat Example', 'pat@example.org', 'home@example.org')] }]);
    const [p] = await client.getPeople(['1']);
    expect(p).toEqual({ id: '1', email: 'pat@example.org', householdEmail: 'home@example.org', firstName: 'Pat', lastName: 'Example', phone: '+15551230000', dtdCompanyId: 'co_1' });
    expect(calls[0]!.variables.ids).toEqual(['1']);
  });

  it('getPeople sends the stored names when they are filled in', async () => {
    const item = person('1', 'Mary Van Der Berg', 'mary@example.org', '');
    item.column_values.push(cv(P.firstName, 'Mary'), cv(P.lastName, 'Van Der Berg'));
    const { client, calls } = mondayFetch([{ items: [item] }]);
    const [p] = await client.getPeople(['1']);
    expect(p).toMatchObject({ firstName: 'Mary', lastName: 'Van Der Berg' });
    expect(calls[0]!.variables.columnIds).toEqual(expect.arrayContaining([P.firstName, P.lastName]));
  });

  it('getPeople asks for the board and drops donors that are not on People (Organizations, People (Historical))', async () => {
    const org = { ...person('2', 'Example Corp', '', ''), board: { id: String(config.boards.organizations) } };
    const historical = { ...person('3', 'Sam Lee', '', ''), board: { id: '99' } };
    const { client, calls } = mondayFetch([{ items: [person('1', 'Pat Example', '', ''), org, historical] }]);
    expect((await client.getPeople(['1', '2', '3'])).map((p) => p.id)).toEqual(['1']);
    expect(calls[0]!.query).toContain('board { id }');
  });

  it('getPeople falls back to the household email, then null', async () => {
    const { client } = mondayFetch([{ items: [person('1', 'Pat', '', 'home@example.org'), person('2', 'Sam Lee', '', '')] }]);
    const [a, b] = await client.getPeople(['1', '2']);
    expect(a!.email).toBe('home@example.org');
    expect(b!.email).toBeNull();
  });

  it('getPeople chunks ids at 100 and skips the call for none', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const { client, calls } = mondayFetch([{ items: [] }, { items: [] }]);
    await client.getPeople(ids);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.variables.ids).toHaveLength(100);
    expect(calls[1]!.variables.ids).toHaveLength(50);
    const none = mondayFetch([]);
    expect(await none.client.getPeople([])).toEqual([]);
    expect(none.calls).toHaveLength(0);
  });

  it('getOrganizationName returns the item name or null', async () => {
    const { client } = mondayFetch([{ items: [{ id: '5', name: 'Example Corp' }] }, { items: [] }]);
    expect(await client.getOrganizationName('5')).toBe('Example Corp');
    expect(await client.getOrganizationName('6')).toBeNull();
  });
});

describe('HttpDtdMondayClient writes', () => {
  it('updateDonation uses change_multiple_column_values with variables only', async () => {
    const { client, calls } = mondayFetch([{ change_multiple_column_values: { id: '9' } }]);
    await client.updateDonation('9', { [D.dtdStatusRaw]: ':waiting-for-donor-action' });
    expect(calls[0]!.query).toContain('change_multiple_column_values');
    expect(calls[0]!.query).toContain('create_labels_if_missing: false');
    expect(calls[0]!.query).not.toContain(':waiting');
    expect(calls[0]!.variables).toEqual({
      boardId: config.boards.donations, itemId: '9',
      columnValues: JSON.stringify({ [D.dtdStatusRaw]: ':waiting-for-donor-action' }),
    });
  });

  it('updatePerson writes to the people board', async () => {
    const { client, calls } = mondayFetch([{ change_multiple_column_values: { id: '1' } }]);
    await client.updatePerson('1', { [P.dtdCompanyId]: 'co_1' });
    expect(calls[0]!.variables.boardId).toBe(config.boards.people);
  });

  it('upsertProgramSummary creates once, then updates the item whose Fiscal Year matches', async () => {
    const { client, calls } = mondayFetch([
      { items_page_by_column_values: { items: [] } },
      { create_item: { id: '70' } },
      { items_page_by_column_values: { items: [{ id: '70' }] } },
      { change_multiple_column_values: { id: '70' } },
    ]);
    await client.upsertProgramSummary('FY2026', { [S.screened]: 10 });
    expect(calls[0]!.variables.columns).toEqual([{ column_id: S.fiscalYear, column_values: ['FY2026'] }]);
    expect(calls[1]!.query).toContain('create_item');
    expect(calls[1]!.query).toContain('create_labels_if_missing: false');
    expect(calls[1]!.variables.itemName).toBe('FY2026');
    expect(JSON.parse(calls[1]!.variables.columnValues)).toEqual({ [S.screened]: 10, [S.fiscalYear]: 'FY2026' });

    await client.upsertProgramSummary('FY2026', { [S.screened]: 11 });
    expect(calls[3]!.query).toContain('change_multiple_column_values');
    expect(calls[3]!.variables.itemId).toBe('70');
    expect(calls[3]!.variables.boardId).toBe(config.boards.programSummary);
    expect(calls.filter((c) => c.query.includes('create_item'))).toHaveLength(1);
  });
});
