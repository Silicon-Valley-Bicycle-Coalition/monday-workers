import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient, MondayRateLimitError } from './client';

const COLUMNS = { amount: 'amount_1', date: 'date_1', fiscalYear: null, status: 'status_1' };

// Shapes one GraphQL items response the way getDonationsByIds reads it back.
function itemsResponse(items: { id: string; cells: Record<string, string | null> }[]) {
  return {
    data: {
      items: items.map((i) => ({
        id: i.id,
        column_values: Object.entries(i.cells).map(([id, text]) => ({ id, text })),
      })),
    },
  };
}

function clientReturning(body: unknown): HttpMondayClient {
  // A fresh Response per call — a Response body can only be read once, and some callers
  // (getDonationsByIds, getAffiliationSummary) invoke fetch more than once against one client.
  vi.stubGlobal('fetch', vi.fn().mockImplementation(
    () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))));
  return new HttpMondayClient('https://api.monday.test/v2', 'token');
}

// Like clientReturning, but scripts successive fetch calls to resolve each body in turn —
// for methods (like getAffiliationSummary) that make more than one GraphQL request.
function clientReturningSequence(bodies: unknown[]): HttpMondayClient {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
  }
  vi.stubGlobal('fetch', fetchMock);
  return new HttpMondayClient('https://api.monday.test/v2', 'token');
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

describe('getOwnerMembership', () => {
  const OWNER = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil' };
  it('returns the four values, blanks as null', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'o1', cells: { ms: 'Active', mt: 'Member', msince: '2015-01-01', muntil: '' } },
    ]));
    expect(await client.getOwnerMembership('o1', OWNER))
      .toEqual({ statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: null });
  });
  it('a never-member reads as all null', async () => {
    const client = clientReturning(itemsResponse([{ id: 'o1', cells: { ms: null, mt: null, msince: null, muntil: null } }]));
    expect(await client.getOwnerMembership('o1', OWNER))
      .toEqual({ statusLabel: null, tierLabel: null, since: null, until: null });
  });
  it('a missing item reads as all null rather than throwing', async () => {
    const client = clientReturning(itemsResponse([]));
    expect(await client.getOwnerMembership('gone', OWNER))
      .toEqual({ statusLabel: null, tierLabel: null, since: null, until: null });
  });
  it('normalizes since/until that carry a time component', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'o1', cells: { ms: 'Active', mt: 'Member', msince: '2015-01-01 09:00', muntil: '2027-04-11 00:00' } },
    ]));
    expect(await client.getOwnerMembership('o1', OWNER)).toMatchObject({ since: '2015-01-01', until: '2027-04-11' });
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
    return new HttpMondayClient('https://api.monday.test/v2', 'token');
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
    expect(http.message).toBe('monday API: HTTP 500');
  });
});
