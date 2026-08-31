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

  it('an explicit $0 amount is kept — only blank is malformed', async () => {
    const client = clientReturning(itemsResponse([
      { id: 'zero', cells: { amount_1: '0', date_1: '2020-01-15', status_1: 'Received' } },
    ]));
    const result = await client.getDonationsByIds(['zero'], COLUMNS);
    expect(result.map((d) => [d.id, d.amount])).toEqual([['zero', 0]]);
  });
});
