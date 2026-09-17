import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpMondayClient } from './client';

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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200 })));
  return new HttpMondayClient('https://api.monday.test/v2', 'token');
}

afterEach(() => vi.unstubAllGlobals());

describe('getDonationsByIds', () => {
  it('parses a well-formed donation', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['dn1'], COLUMNS);
    expect(result).toEqual([
      { id: 'dn1', amount: 50, dateISO: '2020-01-15', fiscalYear: 2020, status: 'Received', giftType: undefined },
    ]);
  });

  it('excludes an item with a valid date but a blank Amount — Number("") is 0, and a $0 refresh would overwrite the ledger\'s real amount', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'blank', cells: { amount_1: '', date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'nullcell', cells: { amount_1: null, date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'spaces', cells: { amount_1: '   ', date_1: '2020-01-15', status_1: 'Received' } },
      { id: 'ok', cells: { amount_1: '25', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['blank', 'nullcell', 'spaces', 'ok'], COLUMNS);
    expect(result.map((d) => d.id)).toEqual(['ok']);
  });

  it('still excludes blank-date and NaN-amount items', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'nodate', cells: { amount_1: '50', date_1: '', status_1: 'Received' } },
      { id: 'nan', cells: { amount_1: 'not a number', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    expect(await client.getDonationsByIds(['nodate', 'nan'], COLUMNS)).toEqual([]);
  });

  it('derives fiscal year from Date when the configured Fiscal Year cell is blank — Number("") is 0, not NaN, which would bucket the gift into fiscal year 0 and drop it from This/Last Year', async () => {
    const withFY = { ...COLUMNS, fiscalYear: 'text_fy' };
    const client = clientReturning(itemsResponse([
      { id: 'blank', cells: { amount_1: '50', date_1: '2020-01-15', text_fy: '', status_1: 'Received' } },
      { id: 'nullcell', cells: { amount_1: '50', date_1: '2020-08-15', text_fy: null, status_1: 'Received' } },
      { id: 'spaces', cells: { amount_1: '50', date_1: '2020-08-15', text_fy: '   ', status_1: 'Received' } },
      { id: 'stamped', cells: { amount_1: '50', date_1: '2020-08-15', text_fy: '2022', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['blank', 'nullcell', 'spaces', 'stamped'], withFY);
    expect(result.map((d) => [d.id, d.fiscalYear])).toEqual([
      ['blank', 2020], ['nullcell', 2021], ['spaces', 2021], ['stamped', 2022],
    ]);
  });

  it('an explicit $0 amount is kept — only blank is malformed', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'zero', cells: { amount_1: '0', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['zero'], COLUMNS);
    expect(result.map((d) => [d.id, d.amount])).toEqual([['zero', 0]]);
  });
});

describe('getDonationsByIds — membership term columns', () => {
  const TERM_COLUMNS = { ...COLUMNS, giftType: 'gt_1', termStart: 'ts_1', termEnd: 'te_1', membershipType: 'mty_1' };

  it('reads the three term columns when configured, blank as null', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2026-11-05', status_1: 'Received', gt_1: 'Donation',
        ts_1: '2026-11-05', te_1: '', mty_1: 'Lifetime' } },
    ]));
    const [d] = await client.getDonationsByIds(['dn1'], TERM_COLUMNS);
    expect(d).toMatchObject({ giftType: 'Donation', termStart: '2026-11-05', termEnd: null, membershipType: 'Lifetime' });
  });

  it('leaves the term fields undefined when the board has no term columns', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2026-11-05', status_1: 'Received' } },
    ]));
    const [d] = await client.getDonationsByIds(['dn1'], COLUMNS);
    expect(d!.termStart).toBeUndefined();
    expect(d!.termEnd).toBeUndefined();
    expect(d!.membershipType).toBeUndefined();
  });

  it('requests the term column ids from Monday', async () => {
    const client = clientReturning(itemsResponse([]));
    await client.getDonationsByIds(['dn1'], TERM_COLUMNS);
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columnIds).toEqual(expect.arrayContaining(['ts_1', 'te_1', 'mty_1']));
  });

  it('normalizes term dates that carry a time component to YYYY-MM-DD', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'dn1', cells: { amount_1: '50', date_1: '2026-11-05', status_1: 'Received', gt_1: 'Donation',
        ts_1: '2026-11-05 00:00', te_1: '2027-11-05 13:30', mty_1: 'Renewal' } },
    ]));
    const [d] = await client.getDonationsByIds(['dn1'], TERM_COLUMNS);
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
