import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient, MondayRateLimitError, statusLabel } from './client';
import { AmbiguousWriteError, MONDAY_API_VERSION } from './graphql';

const COLUMNS = { amount: 'amount_1', date: 'date_1', fiscalYear: null, status: 'status_1' };

// The transport's retries don't really wait in tests.
const NO_SLEEP = { sleepFn: async () => {} };

// A cell's stored value as Monday returns it: a status label's index, null when the cell is empty.
const valueOf = (text: string | null): string | null => (text ? '{"index":1}' : null);

// Shapes one GraphQL items response the way getDonationsByIds reads it back. `values`
// overrides a cell's stored value — e.g. null under a status cell whose text is the id-5 label.
function itemsResponse(items: { id: string; cells: Record<string, string | null>; values?: Record<string, string | null> }[]) {
  return {
    data: {
      items: items.map((i) => ({
        id: i.id,
        column_values: Object.entries(i.cells).map(([id, text]) =>
          ({ id, text, value: i.values && id in i.values ? i.values[id] : valueOf(text) })),
      })),
    },
  };
}

function clientReturning(body: unknown): HttpMondayClient {
  // A fresh Response per call — a Response body can only be read once, and some callers
  // (getDonationsByIds, getAffiliationSummary) invoke fetch more than once against one client.
  vi.stubGlobal('fetch', vi.fn().mockImplementation(
    () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))));
  return new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP);
}

// Like clientReturning, but scripts successive fetch calls to resolve each body in turn —
// for methods (like getAffiliationSummary) that make more than one GraphQL request.
function clientReturningSequence(bodies: unknown[]): HttpMondayClient {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  }
  vi.stubGlobal('fetch', fetchMock);
  return new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP);
}

afterEach(() => vi.unstubAllGlobals());

// items(ids:) keeps returning an item in Monday's trash, state 'deleted', with its columns intact
// (the same read processRegistration already guards) — so a deleted gift still shows its Donor
// link, and a deleted owner still resolves to its board.
describe('items in the trash read as gone', () => {
  it('getDonorLinkForDonation: a deleted gift links to no one', async () => {
    const client = clientReturning({ data: { items: [
      { state: 'deleted', column_values: [{ id: 'donor_link', linked_item_ids: ['donor-1'] }] }] } });
    expect(await client.getDonorLinkForDonation('dn1', 'donor_link')).toBeNull();
  });

  it('getDonorLinkForDonation: an active gift still returns its owner', async () => {
    const client = clientReturning({ data: { items: [
      { state: 'active', column_values: [{ id: 'donor_link', linked_item_ids: ['donor-1'] }] }] } });
    expect(await client.getDonorLinkForDonation('dn1', 'donor_link')).toBe('donor-1');
  });

  it('getDonorLinkWithBoard: returns the owner and its board from one query', async () => {
    const client = clientReturning({ data: { items: [{ state: 'active', column_values: [{ id: 'donor_link', linked_item_ids: ['donor-1'],
      linked_items: [{ id: 'donor-1', state: 'active', board: { id: '2' } }] }] }] } });
    expect(await client.getDonorLinkWithBoard('dn1', 'donor_link')).toEqual({ ownerItemId: 'donor-1', ownerBoardId: '2' });
  });

  it('getDonorLinkWithBoard: a trashed or unreturned owner has a null board; a deleted gift has no link', async () => {
    const trashed = clientReturning({ data: { items: [{ state: 'active', column_values: [{ id: 'donor_link', linked_item_ids: ['donor-1'],
      linked_items: [{ id: 'donor-1', state: 'deleted', board: { id: '2' } }] }] }] } });
    expect(await trashed.getDonorLinkWithBoard('dn1', 'donor_link')).toEqual({ ownerItemId: 'donor-1', ownerBoardId: null });
    const missing = clientReturning({ data: { items: [{ state: 'active', column_values: [{ id: 'donor_link', linked_item_ids: ['donor-1'], linked_items: [] }] }] } });
    expect(await missing.getDonorLinkWithBoard('dn1', 'donor_link')).toEqual({ ownerItemId: 'donor-1', ownerBoardId: null });
    const gift = clientReturning({ data: { items: [{ state: 'deleted', column_values: [{ id: 'donor_link', linked_item_ids: ['donor-1'] }] }] } });
    expect(await gift.getDonorLinkWithBoard('dn1', 'donor_link')).toBeNull();
  });

  it('getItemBoardId: a deleted item has no board', async () => {
    const client = clientReturning({ data: { items: [{ state: 'deleted', board: { id: '2' } }] } });
    expect(await client.getItemBoardId('donor-1')).toBeNull();
  });

  it('getItemBoardId: an archived item keeps its board', async () => {
    const client = clientReturning({ data: { items: [{ state: 'archived', board: { id: '2' } }] } });
    expect(await client.getItemBoardId('donor-1')).toBe('2');
  });

  it('getDonationsByIds: skips a deleted gift so a recompute never re-asserts it', async () => {
    const response = itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'dn2', cells: { amount_1: '75', date_1: '2020-02-15', status_1: 'Received' } },
    ]);
    (response.data.items[1] as Record<string, unknown>).state = 'deleted';
    const result = await clientReturning(response).getDonationsByIds(['dn1', 'dn2'], COLUMNS, 7);
    expect(result.map((d) => d.id)).toEqual(['dn1']);
  });
});

describe('getDonationsByIds archived state', () => {
  it('getDonationsByIds marks archived items', async () => {
    const response = itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'dn2', cells: { amount_1: '75', date_1: '2020-02-15', status_1: 'Received' } },
    ]);
    (response.data.items[0] as Record<string, unknown>).state = 'archived';
    (response.data.items[1] as Record<string, unknown>).state = 'active';
    const result = await clientReturning(response).getDonationsByIds(['dn1', 'dn2'], COLUMNS, 7);
    expect(result.map((d) => [d.id, d.archived])).toEqual([['dn1', true], ['dn2', false]]);
  });
});

describe('getDonationsByIds', () => {
  it('parses a well-formed donation', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['dn1'], COLUMNS, 7);
    expect(result).toEqual([
      { id: 'dn1', amountCents: 5000, dateISO: '2020-01-15', fiscalYear: 2020, status: 'Received', giftType: undefined, archived: false },
    ]);
  });

  it('excludes an item with a valid date but a blank Amount — Number("") is 0, and a $0 refresh would overwrite the ledger\'s real amount', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'blank', cells: { amount_1: '', date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'nullcell', cells: { amount_1: null, date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'spaces', cells: { amount_1: '   ', date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'ok', cells: { amount_1: '25', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['blank', 'nullcell', 'spaces', 'ok'], COLUMNS, 7);
    expect(result.map((d) => d.id)).toEqual(['ok']);
  });

  it('still excludes blank-date and NaN-amount items', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'nodate', cells: { amount_1: '50', date_1: '', status_1: 'Received' } },
      { id: 'nan', cells: { amount_1: 'not a number', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    expect(await client.getDonationsByIds(['nodate', 'nan'], COLUMNS, 7)).toEqual([]);
  });

  it('derives fiscal year from Date when the configured Fiscal Year cell is blank — Number("") is 0, not NaN, which would bucket the gift into fiscal year 0 and drop it from This/Last Year', async () => {
    const withFY = { ...COLUMNS, fiscalYear: 'text_fy' };
    const client = clientReturning(itemsResponse([
      { id: 'blank', cells: { amount_1: '50', date_1: '2020-01-15', text_fy: '', status_1: 'Received' } },
      { id: 'nullcell', cells: { amount_1: '50', date_1: '2020-08-15', text_fy: null, status_1: 'Received' } },
      { id: 'spaces', cells: { amount_1: '50', date_1: '2020-08-15', text_fy: '   ', status_1: 'Received' } },
      { id: 'stamped', cells: { amount_1: '50', date_1: '2020-08-15', text_fy: '2022', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['blank', 'nullcell', 'spaces', 'stamped'], withFY, 7);
    expect(result.map((d) => [d.id, d.fiscalYear])).toEqual([
      ['blank', 2020], ['nullcell', 2021], ['spaces', 2021], ['stamped', 2022],
    ]);
  });

  it('an explicit $0 amount is kept — only blank is malformed', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'zero', cells: { amount_1: '0', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['zero'], COLUMNS, 7);
    expect(result.map((d) => [d.id, d.amountCents])).toEqual([['zero', 0]]);
  });

  it('parses Amount text straight to integer cents — thousands separators, refunds, sub-cent decimals (issue #27)', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'comma', cells: { amount_1: '1,234.5', date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'refund', cells: { amount_1: '-25.10', date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'float', cells: { amount_1: '714.9300000000001', date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'half', cells: { amount_1: '1.005', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['comma', 'refund', 'float', 'half'], COLUMNS, 7);
    expect(result.map((d) => [d.id, d.amountCents])).toEqual([
      ['comma', 123450], ['refund', -2510], ['float', 71493], ['half', 101],
    ]);
  });
});

describe('getDonationsByIds — membership term columns', () => {
  const TERM_COLUMNS = { ...COLUMNS, giftType: 'gt_1', termStart: 'ts_1', termEnd: 'te_1', membershipType: 'mty_1' };

  it('reads the three term columns when configured, blank as null', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2026-11-05', status_1: 'Received', gt_1: 'Donation',
        ts_1: '2026-11-05', te_1: '', mty_1: 'Lifetime' } },
    ]));
    const [d] = await client.getDonationsByIds(['dn1'], TERM_COLUMNS, 7);
    expect(d).toMatchObject({ giftType: 'Donation', termStart: '2026-11-05', termEnd: null, membershipType: 'Lifetime' });
  });

  it('leaves the term fields undefined when the board has no term columns', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2026-11-05', status_1: 'Received' } },
    ]));
    const [d] = await client.getDonationsByIds(['dn1'], COLUMNS, 7);
    expect(d!.termStart).toBeUndefined();
    expect(d!.termEnd).toBeUndefined();
    expect(d!.membershipType).toBeUndefined();
  });

  it('requests the term column ids from Monday', async () => {
    const client = clientReturning(itemsResponse([]));
    await client.getDonationsByIds(['dn1'], TERM_COLUMNS, 7);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columnIds).toEqual(expect.arrayContaining(['ts_1', 'te_1', 'mty_1']));
  });

  it('normalizes term dates that carry a time component to YYYY-MM-DD', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2026-11-05', status_1: 'Received', gt_1: 'Donation',
        ts_1: '2026-11-05 00:00', te_1: '2027-11-05 13:30', mty_1: 'Renewal' } },
    ]));
    const [d] = await client.getDonationsByIds(['dn1'], TERM_COLUMNS, 7);
    expect(d).toMatchObject({ termStart: '2026-11-05', termEnd: '2027-11-05', membershipType: 'Renewal' });
  });
});

describe('getOwnerMembership (eight columns)', () => {
  const OWNER = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
  it('returns all eight, blanks as null, Lapse Count as a number', async () => {
    const client = clientReturning(itemsResponse([{ id: 'o1', cells: {
      ms: 'Active', mt: 'Member', msince: '2015-01-01', muntil: '2027-12-03 00:00', mcts: '2026-11-03', mtype: 'New', mlc: '2', mll: '' } }]));
    expect(await client.getOwnerMembership('o1', OWNER)).toEqual({
      statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2027-12-03',
      currentTermStart: '2026-11-03', memberTypeLabel: 'New', lapseCount: 2, lastLapsed: null });
  });
  it('a missing item reads as all null rather than throwing', async () => {
    const client = clientReturning(itemsResponse([]));
    expect(await client.getOwnerMembership('gone', OWNER)).toEqual({
      statusLabel: null, tierLabel: null, since: null, until: null, currentTermStart: null, memberTypeLabel: null, lapseCount: null, lastLapsed: null });
  });
});

const VOL_BOARD = { boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: 'hrs' as string | null },
  eventBoard: { boardId: 8, columns: { start: 'start' } }, volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'] };

describe('registrations and events', () => {
  const regResponse = (cells: Record<string, string | null>, links: Record<string, string[]>, state = 'active') => ({ data: { items: [{ id: 'r1', state, column_values:
    Object.entries(cells).map(([id, text]) => ({ id, text, value: valueOf(text), ...(links[id] ? { linked_item_ids: links[id] } : {}) })) }] } });
  it('getRegistration reads links, labels and hours; blank hours is null', async () => {
    const client = clientReturning(regResponse({ att: 'Ada', ev: 'Bike Party', atd: 'Attended', role: 'Volunteer', hrs: '' }, { att: ['p1'], ev: ['e1'] }));
    expect(await client.getRegistration('r1', VOL_BOARD)).toEqual({ id: 'r1', state: 'active', attendeeItemId: 'p1', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null });
  });
  it('getRegistration parses the item state: archived and deleted are returned as such', async () => {
    expect((await clientReturning(regResponse({ att: '' }, {}, 'archived')).getRegistration('r1', VOL_BOARD))?.state).toBe('archived');
    expect((await clientReturning(regResponse({ att: '' }, {}, 'deleted')).getRegistration('r1', VOL_BOARD))?.state).toBe('deleted');
  });
  it('getRegistration without an hours column configured reads hours as null; a deleted item is null', async () => {
    const client = clientReturning(regResponse({ att: '', ev: '', atd: 'Registered', role: '' }, {}));
    expect(await client.getRegistration('r1', { ...VOL_BOARD, columns: { ...VOL_BOARD.columns, hours: null } }))
      .toEqual({ id: 'r1', state: 'active', attendeeItemId: null, eventItemId: null, attendanceLabel: 'Registered', roleLabel: null, hours: null });
    expect(await clientReturning({ data: { items: [] } }).getRegistration('gone', VOL_BOARD)).toBeNull();
  });
  it('getEventStart normalizes to a date and returns null for blank or missing', async () => {
    expect(await clientReturning(itemsResponse([{ id: 'e1', cells: { start: '2027-05-02 18:00' } }])).getEventStart('e1', 'start')).toBe('2027-05-02');
    expect(await clientReturning(itemsResponse([{ id: 'e1', cells: { start: '' } }])).getEventStart('e1', 'start')).toBeNull();
    expect(await clientReturning(itemsResponse([])).getEventStart('e1', 'start')).toBeNull();
  });
  it('pageRegistrations returns the page and cursor with the same record shape, state included', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: 'next', items: [{ id: 'r1', state: 'archived', column_values: [
      { id: 'att', text: 'Ada', linked_item_ids: ['p1'] }, { id: 'ev', text: 'X', linked_item_ids: ['e1'] },
      { id: 'atd', text: 'Attended', value: '{"index":1}' }, { id: 'role', text: 'Volunteer', value: '{"index":2}' }, { id: 'hrs', text: '3' }] }] } }] } });
    expect(await client.pageRegistrations(VOL_BOARD, null)).toEqual({ cursor: 'next',
      items: [{ id: 'r1', state: 'archived', attendeeItemId: 'p1', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: 3 }] });
  });
  it('pageHistoricalShifts reads Volunteer link, Date, Hours and Status', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [{ id: 'v1', column_values: [
      { id: 'vol', text: 'Ada', linked_item_ids: ['p1'] }, { id: 'dt', text: '2019-06-01' }, { id: 'hrs', text: '2' }, { id: 'st', text: 'Completed', value: '{"index":1}' }] }] } }] } });
    expect(await client.pageHistoricalShifts({ boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'] }, null))
      .toEqual({ cursor: null, items: [{ id: 'v1', volunteerItemId: 'p1', dateISO: '2019-06-01', hours: 2, statusLabel: 'Completed', historical: false }] });
  });
  it('pageHistoricalShifts reads the Historical checkbox when configured', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [
      { id: 'v1', column_values: [{ id: 'hist', text: 'v', value: '{"checked":"true"}' }, { id: 'st', text: 'Completed', value: '{"index":1}' }] },
      { id: 'v2', column_values: [{ id: 'hist', text: '', value: null }, { id: 'st', text: 'Completed', value: '{"index":1}' }] }] } }] } });
    const page = await client.pageHistoricalShifts({ boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st', historical: 'hist' }, countedStatusLabels: ['Completed'] }, null);
    expect(page.items.map((i) => [i.id, i.historical])).toEqual([['v1', true], ['v2', false]]);
  });
  it('getItemsBoardIds maps ids to boards and omits missing items', async () => {
    const client = clientReturning({ data: { items: [{ id: 'p1', board: { id: '20' } }, { id: 'p2', board: { id: '28' } }] } });
    expect(await client.getItemsBoardIds(['p1', 'p2', 'p3'])).toEqual(new Map([['p1', '20'], ['p2', '28']]));
  });
});

describe('HttpMondayClient — affiliation model reads', () => {
  it('getDonationsByIds returns actingForItemId from the board_relation when configured, undefined otherwise', async () => {
    const respond = { items: [{ id: 'dn1', column_values: [
      { id: 'amount_1', text: '50' }, { id: 'date_1', text: '2024-02-02' }, { id: 'status_1', text: 'Received' },
      { id: 'af_1', text: 'Ada @ Acme', linked_item_ids: ['af-1'] } ] }] };
    const client = clientReturning({ data: respond });
    const [withAf] = await client.getDonationsByIds(['dn1'], { amount: 'amount_1', date: 'date_1', status: 'status_1', fiscalYear: null, actingForLink: 'af_1' }, 7);
    expect(withAf!.actingForItemId).toBe('af-1');
    const [without] = await client.getDonationsByIds(['dn1'], { amount: 'amount_1', date: 'date_1', status: 'status_1', fiscalYear: null }, 7);
    expect(without!.actingForItemId).toBeUndefined();
  });
  it('getDonationsByIds reports null when the configured Acting for column is empty', async () => {
    const respond = { items: [{ id: 'dn1', column_values: [
      { id: 'amount_1', text: '50' }, { id: 'date_1', text: '2024-02-02' }, { id: 'status_1', text: 'Received' },
      { id: 'af_1', text: '', linked_item_ids: [] } ] }] };
    const [d] = await clientReturning({ data: respond }).getDonationsByIds(['dn1'], { amount: 'amount_1', date: 'date_1', status: 'status_1', fiscalYear: null, actingForLink: 'af_1' }, 7);
    expect(d!.actingForItemId).toBeNull();
  });
  it('getAffiliationSummary returns the item name and its Person link + board', async () => {
    const calls = [
      { items: [{ id: 'af-1', name: 'Ada @ Acme', column_values: [{ id: 'br_p', linked_item_ids: ['p-1'] }] }] },
      { items: [{ board: { id: '18428131737' } }] },
    ];
    const client = clientReturningSequence(calls.map((c) => ({ data: c })));
    expect(await client.getAffiliationSummary('af-1', 'br_p')).toEqual({ name: 'Ada @ Acme', personItemId: 'p-1', personBoardId: '18428131737' });
  });
  it('getPersonEmployerState returns the Employer Name text and the Affiliations link', async () => {
    const client = clientReturning({ data: { items: [{ state: 'active', column_values: [
      { id: 'emp', text: 'Old Co' }, { id: 'br_a', text: null, linked_item_ids: ['af-1', 'af-2'] }] }] } });
    expect(await client.getPersonEmployerState('p-1', { employerName: 'emp', affiliationsLink: 'br_a' }))
      .toEqual({ employerName: 'Old Co', affiliationItemIds: ['af-1', 'af-2'] });
  });
  it('getPersonEmployerState: a person in the trash or gone reads as null', async () => {
    const cols = { employerName: 'emp', affiliationsLink: 'br_a' };
    expect(await clientReturning({ data: { items: [{ state: 'deleted', column_values: [] }] } }).getPersonEmployerState('p-1', cols)).toBeNull();
    expect(await clientReturning({ data: { items: [] } }).getPersonEmployerState('p-1', cols)).toBeNull();
  });
  it('getEmployerAffiliations reads status, primary and the linked organization name, skipping items not active', async () => {
    const client = clientReturning({ data: { items: [
      { id: 'af-1', state: 'active', column_values: [{ id: 'st', text: 'Current' }, { id: 'pr', text: 'v', checked: true },
        { id: 'br_o', text: null, linked_items: [{ name: 'Acme' }] }] },
      { id: 'af-2', state: 'active', column_values: [{ id: 'st', text: 'Former' }, { id: 'pr', text: '', checked: false },
        { id: 'br_o', text: null, linked_items: [] }] },
      { id: 'af-3', state: 'deleted', column_values: [{ id: 'st', text: 'Current' }, { id: 'pr', text: '', checked: false },
        { id: 'br_o', text: null, linked_items: [{ name: 'Trashed' }] }] },
    ] } });
    expect(await client.getEmployerAffiliations(['af-1', 'af-2', 'af-3'], { organizationLink: 'br_o', status: 'st', primary: 'pr' })).toEqual([
      { id: 'af-1', statusLabel: 'Current', primary: true, organizationName: 'Acme' },
      { id: 'af-2', statusLabel: 'Former', primary: false, organizationName: null },
    ]);
  });
  it('getAffiliationSummary: no Person link → nulls; deleted item → null', async () => {
    expect(await clientReturningSequence([{ data: { items: [{ id: 'af-1', name: 'X @ Y', column_values: [{ id: 'br_p', linked_item_ids: [] }] }] } }])
      .getAffiliationSummary('af-1', 'br_p')).toEqual({ name: 'X @ Y', personItemId: null, personBoardId: null });
    expect(await clientReturningSequence([{ data: { items: [] } }]).getAffiliationSummary('af-gone', 'br_p')).toBeNull();
  });
});

// Issue #27: Monday rate-limit and complexity-budget errors surface as MondayRateLimitError,
// carrying Monday's own retry hint when it gave one, so the consumer can delay the retry.
describe('Monday rate-limit errors', () => {
  function clientResponding(body: unknown, init: ResponseInit = { status: 200 }): HttpMondayClient {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(
      () => Promise.resolve(new Response(JSON.stringify(body), init))));
    return new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP);
  }
  const read = (c: HttpMondayClient) => c.getItemBoardId('1');

  it('a COMPLEXITY_BUDGET_EXHAUSTED GraphQL error carries extensions.retry_in_seconds', async () => {
    const err = await read(clientResponding({ errors: [{ message: 'Complexity budget exhausted',
      extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', status_code: 429, retry_in_seconds: 36 } }] })).catch((e) => e);
    expect(err).toBeInstanceOf(MondayRateLimitError);
    expect(err.retryInSeconds).toBe(36);
    expect(err.message).toContain('Complexity budget exhausted');
  });

  it('recognizes the other rate-limit codes, with or without a retry hint', async () => {
    for (const code of ['RATE_LIMIT_EXCEEDED', 'IP_RATE_LIMIT_EXCEEDED', 'DAILY_LIMIT_EXCEEDED', 'maxConcurrencyExceeded', 'ComplexityException']) {
      const err = await read(clientResponding({ errors: [{ message: code, extensions: { code } }] })).catch((e) => e);
      expect(err, code).toBeInstanceOf(MondayRateLimitError);
      expect(err.retryInSeconds, code).toBeUndefined();
    }
  });

  it('flags DAILY_LIMIT_EXCEEDED as the daily limit, which resets at midnight UTC rather than in seconds', async () => {
    const daily = await read(clientResponding({ errors: [{ message: 'Daily limit exceeded', extensions: { code: 'DAILY_LIMIT_EXCEEDED' } }] })).catch((e) => e);
    expect(daily).toBeInstanceOf(MondayRateLimitError);
    expect(daily.daily).toBe(true);
    const minute = await read(clientResponding({ errors: [{ message: 'x', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 5 } }] })).catch((e) => e);
    expect(minute.daily).toBe(false);
  });

  it('the legacy error_message form ("... reset in 23 seconds", status_code 429) parses its hint', async () => {
    const err = await read(clientResponding({ error_message: 'Complexity budget exhausted, query cost 30001 budget remaining 1000 out of 1000000 reset in 23 seconds',
      status_code: 429 })).catch((e) => e);
    expect(err).toBeInstanceOf(MondayRateLimitError);
    expect(err.retryInSeconds).toBe(23);
  });

  it('HTTP 429 honors a Retry-After header', async () => {
    const err = await read(clientResponding({ error_message: 'Rate Limit Exceeded' },
      { status: 429, headers: { 'Retry-After': '17' } })).catch((e) => e);
    expect(err).toBeInstanceOf(MondayRateLimitError);
    expect(err.retryInSeconds).toBe(17);
  });

  it('HTTP 429 with a body retry hint and no header uses the body', async () => {
    const err = await read(clientResponding({ errors: [{ message: 'x', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 9 } }] },
      { status: 429 })).catch((e) => e);
    expect(err).toBeInstanceOf(MondayRateLimitError);
    expect(err.retryInSeconds).toBe(9);
  });

  it('ordinary GraphQL and HTTP errors stay plain Errors', async () => {
    const gql = await read(clientResponding({ errors: [{ message: 'Column not found', extensions: { code: 'InvalidColumnIdException' } }] })).catch((e) => e);
    expect(gql).not.toBeInstanceOf(MondayRateLimitError);
    expect(gql.message).toContain('Column not found');
    const http = await read(clientResponding({}, { status: 500 })).catch((e) => e);
    expect(http).not.toBeInstanceOf(MondayRateLimitError);
    expect(http.message).toBe('monday API: exhausted 3 attempts — last error: HTTP 500');
  });
});

// #35: the client runs on the canonical transport (src/monday/graphql.ts).
describe('HttpMondayClient transport', () => {
  function recordingFetch(response: () => Response) {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response()));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const apiVersionOf = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
    new Headers((fetchMock.mock.calls[call] as [string, RequestInit])[1].headers).get('API-Version');

  it('retries a Monday blip in-process 3 times, then leaves longer waits to the queue', async () => {
    const fetchMock = recordingFetch(() => new Response('down', { status: 503 }));
    await expect(new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP).getItemBoardId('1')).rejects.toThrow(
      'monday API: exhausted 3 attempts — last error: HTTP 503: down');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('a rate limit that outlasts the in-process retries still surfaces as MondayRateLimitError with its hint', async () => {
    const fetchMock = recordingFetch(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '45' } }));
    const err = await new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP).getItemBoardId('1').catch((e) => e);
    expect(err).toBeInstanceOf(MondayRateLimitError);
    expect(err.retryInSeconds).toBe(45);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('sends the transport\'s single pinned API-Version on every call, setItemDescription included (#39)', async () => {
    const fetchMock = recordingFetch(() => Response.json({ data: { items: [], set_item_description_content: { success: true } } }));
    const client = new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP);
    await client.getItemBoardId('1');
    await client.setItemDescription('1', '# Gifts');
    expect([apiVersionOf(fetchMock, 0), apiVersionOf(fetchMock, 1)]).toEqual([MONDAY_API_VERSION, MONDAY_API_VERSION]);
  });

  it('a create that may have committed stays an AmbiguousWriteError, never reclassified as a rate limit', async () => {
    recordingFetch(() => new Response('bad gateway', { status: 502 }));
    const err = await new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP).createItem(1, 'x', {}).catch((e) => e);
    expect(err).toBeInstanceOf(AmbiguousWriteError);
    expect(err).not.toBeInstanceOf(MondayRateLimitError);
  });

  it('a rate-limit error keeps the transport details alongside retryInSeconds', async () => {
    recordingFetch(() => Response.json({ errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 12 } }] }));
    const err = await new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP).getItemBoardId('1').catch((e) => e);
    expect(err).toBeInstanceOf(MondayRateLimitError);
    expect(err).toMatchObject({ retryInSeconds: 12, retryAfterSeconds: 12, code: 'COMPLEXITY_BUDGET_EXHAUSTED', daily: false });
  });
});

describe('status columns read by stored value (label id 5)', () => {
  it('statusLabel is null for an empty value, unparseable JSON, or no numeric index', () => {
    expect(statusLabel('Other Program Revenue', null)).toBeNull();
    expect(statusLabel('Other Program Revenue', '')).toBeNull();
    expect(statusLabel('Other Program Revenue', 'not json')).toBeNull();
    expect(statusLabel('Other Program Revenue', '{}')).toBeNull();
    expect(statusLabel('Other Program Revenue', '{"index":"5"}')).toBeNull();
    expect(statusLabel('Other Program Revenue', '{"index":5,"post_id":null}')).toBe('Other Program Revenue');
    expect(statusLabel('', '{"index":1}')).toBeNull();
  });
  it('pageItemsColumnsText asks for and returns each raw value', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [{ id: 'g1', column_values: [
      { id: 'fs', text: 'Other Program Revenue', value: null }, { id: 'gs', text: '< $100', value: '{"index":2}' }] }] } }] } });
    const page = await client.pageItemsColumnsText(1, ['fs', 'gs', 'fq'], null);
    expect(page.items[0]!.values).toEqual(new Map([['fs', null], ['gs', '{"index":2}'], ['fq', null]]));
    expect(page.items[0]!.text.get('fs')).toBe('Other Program Revenue');
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string) as { query: string };
    expect(body.query).toMatch(/\{ id text value \.\.\. on BoardRelationValue \{ display_value linked_item_ids \} \}/);
  });
  it('pageRecurringGifts reads a blank status as null even when its text is the id-5 label', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [
      { id: 'r1', column_values: [{ id: 'donor', text: 'Ada', linked_item_ids: ['p1'] }, { id: 'st', text: 'Active', value: null }] },
      { id: 'r2', column_values: [{ id: 'donor', text: 'Bo', linked_item_ids: ['p2'] }, { id: 'st', text: 'Active', value: '{"index":5}' }] }] } }] } });
    const page = await client.pageRecurringGifts({ boardId: 9, columns: { donorLink: 'donor', status: 'st' }, activeStatusLabel: 'Active' }, null);
    expect(page.items.map((i) => i.statusLabel)).toEqual([null, 'Active']);
  });
  const CREDITS_CFG = { boardId: 9, columns: { amount: 'am', date: 'dt', status: 'st', fiscalYear: 'fy', giftType: 'gt',
    donorLink: 'dl', matchedBy: 'mb', anonymous: 'an' } };
  it('pageDonationCredits parses amount, fiscal year, links, status and the Anonymous checkbox', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [
      { id: 'g1', column_values: [{ id: 'am', text: '$1,250.50' }, { id: 'st', text: 'Received', value: '{"index":1}' }, { id: 'fy', text: '2026' },
        { id: 'dt', text: '2026-08-01' },
        { id: 'gt', text: 'Matching Donation' }, { id: 'dl', text: 'Ada', linked_item_ids: ['p1'] }, { id: 'mb', text: 'Acme', linked_item_ids: ['o1'] },
        { id: 'an', text: 'v', value: '{"checked":"true"}' }] },
      { id: 'g2', column_values: [{ id: 'am', text: '' }, { id: 'st', text: 'Received', value: null }, { id: 'fy', text: 'n/a' },
        { id: 'dt', text: '' },
        { id: 'gt', text: '' }, { id: 'dl', text: '' }, { id: 'mb', text: '' }, { id: 'an', text: '', value: null }] }] } }] } });
    expect((await client.pageDonationCredits(CREDITS_CFG, null, 7)).items).toEqual([
      { id: 'g1', fiscalYear: 2026, amountCents: 125050, status: 'Received', giftType: 'Matching Donation',
        donorItemIds: ['p1'], matchedByItemIds: ['o1'], anonymous: true, inKindValueCents: null, recognitionFiscalYear: '' },
      { id: 'g2', fiscalYear: 0, amountCents: null, status: null, giftType: '',
        donorItemIds: [], matchedByItemIds: [], anonymous: false, inKindValueCents: null, recognitionFiscalYear: '' }]);
  });
  it('pageDonationCredits reads In-Kind Value and Recognition Fiscal Year only when configured', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [
      { id: 'g1', column_values: [{ id: 'am', text: '' }, { id: 'fy', text: '2027' }, { id: 'ik', text: '2000' }, { id: 'rfy', text: ' FY2026 ' }] },
      { id: 'g2', column_values: [{ id: 'am', text: '50' }, { id: 'fy', text: '2025' }, { id: 'ik', text: '' }, { id: 'rfy', text: '' }] }] } }] } });
    const cfg = { ...CREDITS_CFG, columns: { ...CREDITS_CFG.columns, inKindValue: 'ik', recognitionFiscalYear: 'rfy' } };
    expect((await client.pageDonationCredits(cfg, null, 7)).items.map((i) => [i.id, i.inKindValueCents, i.recognitionFiscalYear]))
      .toEqual([['g1', 200000, 'FY2026'], ['g2', null, '']]);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string) as { variables: { columnIds: string[] } };
    expect(body.variables.columnIds).toEqual(expect.arrayContaining(['ik', 'rfy']));
  });
  it('pageDonationCredits falls back to the Date for a blank Fiscal Year Ending, as getDonationsByIds does', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [
      { id: 'g1', column_values: [{ id: 'am', text: '50' }, { id: 'fy', text: '' }, { id: 'dt', text: '2026-08-01' }] },
      { id: 'g2', column_values: [{ id: 'am', text: '50' }, { id: 'fy', text: ' ' }, { id: 'dt', text: '2026-06-30 00:00' }] }] } }] } });
    expect((await client.pageDonationCredits(CREDITS_CFG, null, 7)).items.map((i) => [i.id, i.fiscalYear]))
      .toEqual([['g1', 2027], ['g2', 2026]]);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string) as { variables: { columnIds: string[] } };
    expect(body.variables.columnIds).toContain('dt');
  });
  it('pageDonationCredits throws, naming the board, when Monday returns no board', async () => {
    const client = clientReturning({ data: { boards: [] } });
    await expect(client.pageDonationCredits(CREDITS_CFG, null, 7)).rejects.toThrow(/board 9/);
  });
  it('pageItemsColumnsText with requireBoard throws, naming the board, when Monday returns no board', async () => {
    const client = clientReturning({ data: { boards: [] } });
    expect(await client.pageItemsColumnsText(5, ['a'], null)).toEqual({ items: [], cursor: null });
    await expect(client.pageItemsColumnsText(5, ['a'], null, { requireBoard: true })).rejects.toThrow(/board 5/);
  });
  it('getItemsState maps states and leaves unknown ids out', async () => {
    const client = clientReturning({ data: { items: [{ id: 'a', state: 'active' }, { id: 'b', state: 'archived' }] } });
    expect(await client.getItemsState(['a', 'b', 'c'])).toEqual(new Map([['a', 'active'], ['b', 'archived']]));
  });
  it('getDonationsByIds reads a blank Status as blank even when its text is the id-5 label', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'blank', cells: { amount_1: '50', date_1: '2020-01-15', status_1: 'Received' }, values: { status_1: null } },
      { id: 'set', cells: { amount_1: '50', date_1: '2020-01-15', status_1: 'Received' }, values: { status_1: '{"index":5}' } },
    ]));
    expect((await client.getDonationsByIds(['blank', 'set'], COLUMNS, 7)).map((d) => [d.id, d.status]))
      .toEqual([['blank', ''], ['set', 'Received']]);
  });
  it('getOwnerMembership reads blank Status, Tier and Member Type as null even with id-5 text', async () => {
    const OWNER = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
    const client = clientReturning(itemsResponse([{ id: 'o1',
      cells: { ms: 'Lapsed', mt: 'Lifetime', mtype: 'Lapsed renewal', msince: '2015-01-01' },
      values: { ms: null, mt: '{}', mtype: null } }]));
    expect(await client.getOwnerMembership('o1', OWNER))
      .toMatchObject({ statusLabel: null, tierLabel: null, memberTypeLabel: null, since: '2015-01-01' });
  });
  it('registrations and historical shifts read blank status cells as null even with id-5 text', async () => {
    const reg = clientReturning({ data: { items: [{ id: 'r1', state: 'active', column_values: [
      { id: 'att', text: 'Ada', linked_item_ids: ['p1'] }, { id: 'atd', text: 'Attended', value: null }, { id: 'role', text: 'Volunteer', value: null }] }] } });
    expect(await reg.getRegistration('r1', VOL_BOARD)).toMatchObject({ attendanceLabel: null, roleLabel: null });
    const shifts = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [{ id: 'v1', column_values: [
      { id: 'vol', text: 'Ada', linked_item_ids: ['p1'] }, { id: 'dt', text: '2019-06-01' }, { id: 'hrs', text: '2' }, { id: 'st', text: 'Completed', value: null }] }] } }] } });
    expect((await shifts.pageHistoricalShifts({ boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'] }, null)).items[0]!.statusLabel)
      .toBeNull();
  });
});

describe('roll call board writes', () => {
  const sent = () => (vi.mocked(fetch).mock.calls as [string, RequestInit][])
    .map(([, init]) => JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> });

  it('pageItemsColumnsText also reads each item\'s name, group and linked item ids', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [{ id: '7', name: 'Ada', group: { id: 'g26' },
      column_values: [{ id: 'people', text: 'Bo, Ada', value: '{}', linked_item_ids: ['2', '1'] }, { id: 'key', text: '2026|item:1', value: '"x"' }] }] } }] } });
    const item = (await client.pageItemsColumnsText(1, ['people', 'key'], null)).items[0]!;
    expect(item).toMatchObject({ id: '7', name: 'Ada', groupId: 'g26' });
    expect(item.linkedIds).toEqual(new Map([['people', ['2', '1']]]));
    expect(sent()[0]!.query).toMatch(/name group \{ id \}/);
  });

  it('pageItemsColumnsText reads a connect column\'s text from display_value, where Monday puts it', async () => {
    // At API 2026-07 a board_relation cell's text and value are both null; the linked item names
    // come only in display_value (production Donations, 2026-11-16, svbc-monday-migration#113).
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [{ id: '7', name: 'Gift', group: { id: 'g' },
      column_values: [{ id: 'mb', text: null, value: null, display_value: 'Google, LLC', linked_item_ids: ['o1'] },
        { id: 'none', text: null, value: null, display_value: '', linked_item_ids: [] }] }] } }] } });
    const item = (await client.pageItemsColumnsText(1, ['mb', 'none'], null)).items[0]!;
    expect(item.text.get('mb')).toBe('Google, LLC');
    expect(item.text.get('none')).toBeNull();
    expect(sent()[0]!.query).toMatch(/\.\.\. on BoardRelationValue \{ display_value linked_item_ids \}/);
  });

  it('listGroups, createGroup, updateGroupTitle, createItemInGroup, moveItemToGroup and deleteItem send their mutations', async () => {
    const client = clientReturning({ data: {
      boards: [{ groups: [{ id: 'g26', title: 'FY2026' }] }],
      create_group: { id: 'g27' }, update_group: { id: 'g26' }, create_item: { id: '9' }, move_item_to_group: { id: '9' }, delete_item: { id: '9' },
    } });
    expect(await client.listGroups(5)).toEqual([{ id: 'g26', title: 'FY2026' }]);
    expect(await client.createGroup(5, 'FY2027 (in progress)')).toBe('g27');
    await client.updateGroupTitle(5, 'g26', 'FY2026');
    expect(await client.createItemInGroup(5, 'g27', 'Ada', { key: '2027|item:1' })).toBe('9');
    await client.moveItemToGroup('9', 'g26');
    await client.deleteItem('9');
    const calls = sent();
    expect(calls[1]!.query).toMatch(/create_group\(board_id: \$boardId, group_name: \$title\)/);
    expect(calls[2]!.query).toMatch(/update_group\(board_id: \$boardId, group_id: \$groupId, group_attribute: title, new_value: \$title\)/);
    expect(calls[2]!.variables).toEqual({ boardId: '5', groupId: 'g26', title: 'FY2026' });
    expect(calls[3]!.query).toMatch(/create_item\(board_id: \$boardId, group_id: \$groupId, item_name: \$itemName, column_values: \$columnValues\)/);
    expect(calls[3]!.variables).toEqual({ boardId: '5', groupId: 'g27', itemName: 'Ada', columnValues: '{"key":"2027|item:1"}' });
    expect(calls[4]!.query).toMatch(/move_item_to_group\(item_id: \$itemId, group_id: \$groupId\)/);
    expect(calls[5]!.query).toMatch(/delete_item\(item_id: \$itemId\)/);
  });

  it('deleteItem treats an item already gone (say, deleted by an attempt whose response was lost) as deleted', async () => {
    const gone = (message: string, code: string) => new Response(JSON.stringify({ errors: [{ message, extensions: { code } }] }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(gone('Item not found in board', 'ResourceNotFoundException')));
    const client = new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP);
    await expect(client.deleteItem('9')).resolves.toBeUndefined();
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    for (const code of ['InvalidItemIdException', 'ItemNotFoundException']) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(gone('No such item', code)));
      await expect(client.deleteItem('9'), code).resolves.toBeUndefined();
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(gone('User unauthorized to perform action', 'UserUnauthorizedException')));
    await expect(client.deleteItem('9')).rejects.toThrow(/unauthorized/);
  });

  it('a group or item create that may have committed is an AmbiguousWriteError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('bad gateway', { status: 502 }))));
    const client = new HttpMondayClient('https://api.monday.test/v2', 'token', NO_SLEEP);
    expect(await client.createGroup(5, 'FY2027').catch((e) => e)).toBeInstanceOf(AmbiguousWriteError);
    expect(await client.createItemInGroup(5, 'g', 'Ada', {}).catch((e) => e)).toBeInstanceOf(AmbiguousWriteError);
  });
});

describe('HttpMondayClient — sponsorship reads', () => {
  const base = { amount: 'amount_1', date: 'date_1', status: 'status_1', fiscalYear: null };
  const sponsorCols = {
    ...base, sponsorshipCycle: 'cycle_1', inKindValue: 'ik_1', sponsorshipPipelineLinks: ['pl_a', 'pl_b'],
  };
  const respond = (cols: unknown[]) => ({ data: { items: [{ id: 'dn1', column_values: [
    { id: 'amount_1', text: '50' }, { id: 'date_1', text: '2024-02-02' }, { id: 'status_1', text: 'Received' }, ...cols] }] } });

  it('reads sponsorship cycle, in-kind value and pipeline link when configured', async () => {
    const client = clientReturning(respond([
      { id: 'cycle_1', text: ' 2026 Bike Fest ' }, { id: 'ik_1', text: '1,234.50' },
      { id: 'pl_a', text: '', linked_item_ids: [] }, { id: 'pl_b', text: 'Deal', linked_item_ids: ['pipe-9'] }]));
    const [d] = await client.getDonationsByIds(['dn1'], sponsorCols, 7);
    expect(d!.sponsorshipCycle).toBe('2026 Bike Fest');
    expect(d!.inKindValueCents).toBe(123450);
    expect(d!.pipelineItemId).toBe('pipe-9');
  });

  it('reads blank cycle and in-kind value as null, and no pipeline link as null', async () => {
    const client = clientReturning(respond([
      { id: 'cycle_1', text: '  ' }, { id: 'ik_1', text: '' }, { id: 'pl_a', text: '', linked_item_ids: [] }]));
    const [d] = await client.getDonationsByIds(['dn1'], sponsorCols, 7);
    expect(d!.sponsorshipCycle).toBeNull();
    expect(d!.inKindValueCents).toBeNull();
    expect(d!.pipelineItemId).toBeNull();
  });

  it('leaves them undefined when not configured, and does not request their columns', async () => {
    const client = clientReturning(respond([]));
    const [d] = await client.getDonationsByIds(['dn1'], base, 7);
    expect(d!.sponsorshipCycle).toBeUndefined();
    expect(d!.inKindValueCents).toBeUndefined();
    expect(d!.pipelineItemId).toBeUndefined();
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.variables.columnIds).toEqual(['amount_1', 'date_1', 'status_1']);
  });

  it('requests the configured sponsorship columns', async () => {
    const client = clientReturning(respond([]));
    await client.getDonationsByIds(['dn1'], sponsorCols, 7);
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.variables.columnIds).toEqual(expect.arrayContaining(['cycle_1', 'ik_1', 'pl_a', 'pl_b']));
  });

  it('still skips an item with blank Amount even when In-Kind Value is set', async () => {
    const client = clientReturning({ data: { items: [{ id: 'dn1', column_values: [
      { id: 'amount_1', text: '' }, { id: 'date_1', text: '2024-02-02' }, { id: 'status_1', text: 'Received' },
      { id: 'ik_1', text: '500' }] }] } });
    expect(await client.getDonationsByIds(['dn1'], sponsorCols, 7)).toEqual([]);
  });

  it('getItemsBoardAndGroup maps item id to board id and group title, chunking by 100 with limit 100', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `i${i}`);
    const client = clientReturningSequence([
      { data: { items: [{ id: 'i0', board: { id: '20' }, group: { title: 'Sponsors' } }] } },
      { data: { items: [{ id: 'i100', board: { id: '28' }, group: { title: 'Prospects' } }] } },
    ]);
    const out = await client.getItemsBoardAndGroup(ids);
    expect(out).toEqual(new Map([['i0', { boardId: '20', groupTitle: 'Sponsors' }], ['i100', { boardId: '28', groupTitle: 'Prospects' }]]));
    const calls = vi.mocked(fetch).mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
    expect(calls).toHaveLength(2);
    expect(calls[0].variables.ids).toHaveLength(100);
    expect(calls[1].variables.ids).toHaveLength(50);
    expect(calls[0].query).toContain('limit: 100');
  });

  it('getItemsBoardAndGroup omits items that are missing', async () => {
    const client = clientReturning({ data: { items: [] } });
    expect(await client.getItemsBoardAndGroup(['gone'])).toEqual(new Map());
    expect(await client.getItemsBoardAndGroup([])).toEqual(new Map());
  });
});
