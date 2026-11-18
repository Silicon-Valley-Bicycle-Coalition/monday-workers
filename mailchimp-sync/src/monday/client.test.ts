import { describe, it, expect, vi } from 'vitest';
import { AmbiguousWriteError, HttpMondayClient, MondayApiError } from './client';
import { MONDAY_API_VERSION } from './graphql';
import type { MondayColumnsConfig } from '../types';

const COLUMNS: MondayColumnsConfig = {
  membershipStatus: 'status', membershipTier: 'tier', memberSince: 'since', memberUntil: 'until',
  addr1: 'addr1', city: 'city', state: 'state', zip: 'zip', email: 'email', totalGiven: 'given',
  mailchimpCampaigns: 'campaigns', doNotSolicit: 'dns', dnsReasonStatus: 'dnsStatus', nearby: null,
};

// The transport's retries don't really wait in tests.
const noSleep = async () => {};

function fakeFetch(data: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) } as Response);
}

describe('HttpMondayClient GraphQL transport', () => {
  it('sends the transport\'s single pinned API-Version on every request (#39)', async () => {
    const fetchFn = fakeFetch({ items: [] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    await client.getDonorById('42', COLUMNS);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({
        headers: expect.objectContaining({ 'API-Version': MONDAY_API_VERSION }),
      }),
    );
  });

  it("throws with the server's message when a 200 response carries no data", async () => {
    // Monday's rate-limit / auth-failure shape: HTTP 200 with no data and no errors array.
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ error_message: 'Rate limit exceeded', status_code: 429 }),
    } as Response);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    await expect(client.getDonorById('42', COLUMNS)).rejects.toThrow('Rate limit exceeded');
  });
});

describe('HttpMondayClient.getDonorById', () => {
  it('maps column_values to a DonorRecord, defaulting blank columns to empty string', async () => {
    const fetchFn = fakeFetch({
      items: [{
        id: '42',
        column_values: [
          { id: 'email', text: 'a@b.com' }, { id: 'status', text: 'Active' }, { id: 'tier', text: 'Standard' },
          { id: 'since', text: '2026-01-01' }, { id: 'until', text: null }, { id: 'addr1', text: '1 Main St' },
          { id: 'city', text: 'San Jose' }, { id: 'state', text: 'CA' }, { id: 'zip', text: '95110' },
          { id: 'given', text: '150' }, { id: 'dns', text: '' }, { id: 'dnsStatus', text: null },
        ],
      }],
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });

    const donor = await client.getDonorById('42', COLUMNS);

    expect(donor).toEqual({
      id: '42', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
      memberSince: '2026-01-01', memberUntil: '', addr1: '1 Main St', city: 'San Jose',
      state: 'CA', zip: '95110', totalGiven: '150', doNotSolicit: false, dnsReasonStatus: '', nearby: [], hasActiveRecurringGift: false, lastGiftAmount: null, onHistorical: false,
    });
  });

  it("reads a checked Do Not Solicit box (Monday's checkbox text is 'v') and the reason status", async () => {
    const fetchFn = fakeFetch({
      items: [{ id: '42', column_values: [{ id: 'email', text: 'a@b.com' }, { id: 'dns', text: 'v' }, { id: 'dnsStatus', text: 'Confirmed' }] }],
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });

    const donor = await client.getDonorById('42', COLUMNS);

    expect(donor?.doNotSolicit).toBe(true);
    expect(donor?.dnsReasonStatus).toBe('Confirmed');
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columnIds).toEqual(expect.arrayContaining(['dns', 'dnsStatus']));
  });

  it('never requests a State column when state is null, and leaves the state blank', async () => {
    const fetchFn = fakeFetch({ items: [{ id: '42', column_values: [{ id: 'email', text: 'a@b.com' }, { id: 'zip', text: '95110' }] }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });

    const donor = await client.getDonorById('42', { ...COLUMNS, state: null });

    expect(donor?.state).toBe('');
    expect(donor?.zip).toBe('95110');
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columnIds).not.toContain(null);
    expect(body.variables.columnIds).not.toContain('state');
  });

  it('reads the Nearby column when configured, splitting its text on ", " and dropping empties', async () => {
    const fetchFn = fakeFetch({
      items: [{ id: '42', column_values: [{ id: 'email', text: 'a@b.com' }, { id: 'nearby', text: 'Stevens Creek bikeway,  Bay Trail, , Lawrence Expy' }] }],
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });

    const donor = await client.getDonorById('42', { ...COLUMNS, nearby: 'nearby' });

    expect(donor?.nearby).toEqual(['Stevens Creek bikeway', 'Bay Trail', 'Lawrence Expy']);
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columnIds).toContain('nearby');
  });

  it('reads the Has Active Recurring Gift checkbox when configured, and false when not', async () => {
    const fetchFn = fakeFetch({ items: [{ id: '42', column_values: [{ id: 'rg', text: 'v' }] }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    expect((await client.getDonorById('42', { ...COLUMNS, hasActiveRecurringGift: 'rg' }))?.hasActiveRecurringGift).toBe(true);
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columnIds).toContain('rg');

    const blank = fakeFetch({ items: [{ id: '42', column_values: [{ id: 'rg', text: '' }] }] });
    const blankClient = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn: blank, sleepFn: noSleep });
    expect((await blankClient.getDonorById('42', { ...COLUMNS, hasActiveRecurringGift: 'rg' }))?.hasActiveRecurringGift).toBe(false);
    expect((await blankClient.getDonorById('42', COLUMNS))?.hasActiveRecurringGift).toBe(false);
  });

  it('reads Last Gift Amount when configured, and null when the column is not configured', async () => {
    const fetchFn = fakeFetch({ items: [{ id: '42', column_values: [{ id: 'lga', text: '250' }] }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    expect((await client.getDonorById('42', { ...COLUMNS, lastGiftAmount: 'lga' }))?.lastGiftAmount).toBe('250');
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columnIds).toContain('lga');

    const blank = fakeFetch({ items: [{ id: '42', column_values: [{ id: 'lga', text: null }] }] });
    const blankClient = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn: blank, sleepFn: noSleep });
    expect((await blankClient.getDonorById('42', { ...COLUMNS, lastGiftAmount: 'lga' }))?.lastGiftAmount).toBe('');
    expect((await blankClient.getDonorById('42', COLUMNS))?.lastGiftAmount).toBeNull();
  });

  it('gives an empty Nearby list for a blank column, and never requests the column when nearby is null', async () => {
    const fetchFn = fakeFetch({ items: [{ id: '42', column_values: [{ id: 'nearby', text: null }] }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    expect((await client.getDonorById('42', { ...COLUMNS, nearby: 'nearby' }))?.nearby).toEqual([]);

    const nullFetch = fakeFetch({ items: [{ id: '42', column_values: [] }] });
    const nullClient = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn: nullFetch, sleepFn: noSleep });
    expect((await nullClient.getDonorById('42', COLUMNS))?.nearby).toEqual([]);
    const body = JSON.parse((nullFetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.columnIds).not.toContain(null);
  });

  it('returns null when the item no longer exists', async () => {
    const fetchFn = fakeFetch({ items: [] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    expect(await client.getDonorById('999', COLUMNS)).toBeNull();
  });

  it('throws on a GraphQL error response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ errors: [{ message: 'board not found' }] }),
    } as Response);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    await expect(client.getDonorById('42', COLUMNS)).rejects.toThrow('monday API: board not found');
  });
});

describe('HttpMondayClient.createCampaignItem', () => {
  it('returns the new item id', async () => {
    const fetchFn = fakeFetch({ create_item: { id: 'new-item' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    expect(await client.createCampaignItem(123, 'Newsletter')).toBe('new-item');
  });
});

describe('HttpMondayClient.renameItem', () => {
  it('sends the new name via the "name" pseudo-column', async () => {
    const fetchFn = fakeFetch({ change_simple_column_value: { id: 'item1' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    await client.renameItem(123, 'item1', 'New Name');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({ body: expect.stringContaining('"name":"New Name"') }),
    );
  });
});

describe('HttpMondayClient.archiveItem', () => {
  it('archives the given item id', async () => {
    const fetchFn = fakeFetch({ archive_item: { id: 'item1' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    await client.archiveItem('item1');
    expect(fetchFn).toHaveBeenCalled();
  });
});

describe('HttpMondayClient.findItemIdByEmail', () => {
  it('returns the matching item id', async () => {
    const fetchFn = fakeFetch({ items_page_by_column_values: { items: [{ id: '42' }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    expect(await client.findItemIdByEmail(123, 'email', 'a@b.com')).toBe('42');
  });

  it('falls back to a case-insensitive lookup when the exact match misses', async () => {
    // Exact match (salesforce-import lowercases what it writes) comes up empty; the
    // staff-entered item stores the email mixed-case.
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { items_page_by_column_values: { items: [] } } }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { boards: [{ items_page: { items: [
          { id: '7', column_values: [{ text: 'Staff@Example.com' }] },
          { id: '8', column_values: [{ text: 'other@example.com' }] },
        ] } }] } }),
      } as Response);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    expect(await client.findItemIdByEmail(123, 'email', 'staff@example.com')).toBe('7');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('returns null when even the case-insensitive fallback finds no match', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { items_page_by_column_values: { items: [] } } }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { boards: [{ items_page: { items: [
          { id: '8', column_values: [{ text: 'other@example.com' }] },
        ] } }] } }),
      } as Response);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    expect(await client.findItemIdByEmail(123, 'email', 'nobody@b.com')).toBeNull();
  });

  it('does not issue the fallback query when the exact match hits', async () => {
    const fetchFn = fakeFetch({ items_page_by_column_values: { items: [{ id: '42' }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    expect(await client.findItemIdByEmail(123, 'email', 'a@b.com')).toBe('42');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('HttpMondayClient.setConnectColumn', () => {
  it('writes the full linked-item-ids set as JSON', async () => {
    const fetchFn = fakeFetch({ change_column_value: { id: '42' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    await client.setConnectColumn(123, '42', 'campaigns', ['1', '2']);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({ body: expect.stringContaining('"item_ids\\":[1,2]') }),
    );
  });
});

describe('HttpMondayClient rate-limit errors', () => {
  // A fresh Response per call: the transport retries rate limits in-process, and a body can be
  // read only once.
  function respond(init: { status: number; body?: unknown; headers?: Record<string, string> }) {
    return vi.fn(async () =>
      new Response(init.body === undefined ? null : JSON.stringify(init.body), { status: init.status, headers: init.headers }),
    );
  }

  async function errorFrom(fetchFn: ReturnType<typeof respond>): Promise<MondayApiError> {
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    const err = await client.getDonorById('42', COLUMNS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MondayApiError);
    return err as MondayApiError;
  }

  it('reads code and retry_in_seconds from a 429 GraphQL error body', async () => {
    const err = await errorFrom(respond({
      status: 429,
      body: { errors: [{ message: 'Complexity budget exhausted', extensions: { code: 'COMPLEXITY_BUDGET_EXHAUSTED', retry_in_seconds: 22 } }] },
    }));
    expect(err.httpStatus).toBe(429);
    expect(err.code).toBe('COMPLEXITY_BUDGET_EXHAUSTED');
    expect(err.retryAfterSeconds).toBe(22);
    expect(err.message).toBe('monday API: exhausted 3 attempts — last error: HTTP 429: Complexity budget exhausted');
  });

  it('reads the same hint from an HTTP 200 GraphQL errors array', async () => {
    const err = await errorFrom(respond({
      status: 200,
      body: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 40 } }] },
    }));
    expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(err.retryAfterSeconds).toBe(40);
  });

  it('falls back to the Retry-After header when the body has no hint', async () => {
    const err = await errorFrom(respond({ status: 429, headers: { 'Retry-After': '15' } }));
    expect(err.retryAfterSeconds).toBe(15);
    expect(err.message).toBe('monday API: exhausted 3 attempts — last error: HTTP 429');
  });

  it('falls back to error_message when a non-2xx body has an empty errors array', async () => {
    const err = await errorFrom(respond({
      status: 429,
      body: { errors: [], error_message: 'Rate limit exceeded' },
    }));
    expect(err.message).toBe('monday API: exhausted 3 attempts — last error: HTTP 429: Rate limit exceeded');
  });

  it('parses the legacy "reset in N seconds" complexity message', async () => {
    const err = await errorFrom(respond({
      status: 200,
      body: {
        error_code: 'ComplexityException', status_code: 429,
        error_message: 'Complexity budget exhausted, query cost 30001 budget remaining 7897 out of 1000000 reset in 13 seconds',
      },
    }));
    expect(err.code).toBe('ComplexityException');
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfterSeconds).toBe(13);
  });

  it('reports DAILY_LIMIT_EXCEEDED with no hint when Monday gives none', async () => {
    const err = await errorFrom(respond({
      status: 429,
      body: { errors: [{ message: 'Daily limit exceeded', extensions: { code: 'DAILY_LIMIT_EXCEEDED' } }] },
    }));
    expect(err.code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it('fails fast on the daily limit instead of retrying in-process', async () => {
    const fetchFn = respond({ status: 429, body: { errors: [{ message: 'Daily limit exceeded', extensions: { code: 'DAILY_LIMIT_EXCEEDED' } }] } });
    await errorFrom(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('retries a rate limit in-process 3 times before surfacing it', async () => {
    const fetchFn = respond({ status: 429, headers: { 'Retry-After': '15' } });
    await errorFrom(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('never retries a campaign-item create that may have committed', async () => {
    const fetchFn = respond({ status: 502 });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    await expect(client.createCampaignItem(1, 'Newsletter')).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('HttpMondayClient.getDonorById across the two People boards', () => {
  const HISTORICAL = { boardId: 222, columns: {
    membershipStatus: 'h-status', membershipTier: 'h-tier', memberSince: 'h-since', memberUntil: 'h-until',
    addr1: 'h-addr1', city: 'h-city', state: null, zip: 'h-zip', email: 'h-email', totalGiven: 'h-given',
    doNotSolicit: 'h-dns', dnsReasonStatus: 'h-dnsStatus', nearby: null,
  } };

  it('reads an item on the Historical board through that board\'s columns', async () => {
    const fetchFn = fakeFetch({ items: [{
      id: '42', board: { id: '222' },
      column_values: [{ id: 'h-email', text: 'old@b.com' }, { id: 'h-status', text: 'Lapsed' }, { id: 'email', text: null }],
    }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    const donor = await client.getDonorById('42', COLUMNS, HISTORICAL);
    expect(donor).toMatchObject({ email: 'old@b.com', membershipStatus: 'Lapsed', state: '', onHistorical: true });
  });

  it('reads an item on People through the People columns, whichever board the webhook named', async () => {
    const fetchFn = fakeFetch({ items: [{
      id: '42', board: { id: '111' },
      column_values: [{ id: 'email', text: 'live@b.com' }, { id: 'h-email', text: null }],
    }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    const donor = await client.getDonorById('42', COLUMNS, HISTORICAL);
    expect(donor).toMatchObject({ email: 'live@b.com', onHistorical: false });
  });

  it('asks Monday for both boards\' columns, because the item\'s board is only known from the answer', async () => {
    const fetchFn = fakeFetch({ items: [] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', { fetchFn, sleepFn: noSleep });
    await client.getDonorById('42', COLUMNS, HISTORICAL);
    const sent = JSON.parse((fetchFn.mock.calls[0]![1] as RequestInit).body as string) as { query: string; variables: { columnIds: string[] } };
    expect(sent.query).toContain('board { id }');
    expect(sent.variables.columnIds).toEqual(expect.arrayContaining(['email', 'h-email']));
  });
});
