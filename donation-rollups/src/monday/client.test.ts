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

describe('getDonationsByIds', () => {
  it('parses a well-formed donation', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['dn1'], COLUMNS, 7);
    expect(result).toEqual([
      { id: 'dn1', amountCents: 5000, dateISO: '2020-01-15', fiscalYear: 2020, status: 'Received', giftType: undefined },
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
      .toEqual({ cursor: null, items: [{ id: 'v1', volunteerItemId: 'p1', dateISO: '2019-06-01', hours: 2, statusLabel: 'Completed' }] });
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
    expect(body.query).toMatch(/\{ id text value \}/);
  });
  it('pageRecurringGifts reads a blank status as null even when its text is the id-5 label', async () => {
    const client = clientReturning({ data: { boards: [{ items_page: { cursor: null, items: [
      { id: 'r1', column_values: [{ id: 'donor', text: 'Ada', linked_item_ids: ['p1'] }, { id: 'st', text: 'Active', value: null }] },
      { id: 'r2', column_values: [{ id: 'donor', text: 'Bo', linked_item_ids: ['p2'] }, { id: 'st', text: 'Active', value: '{"index":5}' }] }] } }] } });
    const page = await client.pageRecurringGifts({ boardId: 9, columns: { donorLink: 'donor', status: 'st' }, activeStatusLabel: 'Active' }, null);
    expect(page.items.map((i) => i.statusLabel)).toEqual([null, 'Active']);
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
