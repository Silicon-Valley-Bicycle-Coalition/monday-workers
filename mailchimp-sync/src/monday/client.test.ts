import { describe, it, expect, vi } from 'vitest';
import { HttpMondayClient } from './client';
import type { MondayColumnsConfig } from '../types';

const COLUMNS: MondayColumnsConfig = {
  membershipStatus: 'status', membershipTier: 'tier', memberSince: 'since', memberUntil: 'until',
  addr1: 'addr1', city: 'city', state: 'state', zip: 'zip', email: 'email', totalGiven: 'given',
  mailchimpCampaigns: 'campaigns',
};

function fakeFetch(data: unknown) {
  return vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) } as Response);
}

describe('HttpMondayClient GraphQL transport', () => {
  it('pins the Monday API version on every request', async () => {
    const fetchFn = fakeFetch({ items: [] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await client.getDonorById('42', COLUMNS);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({
        headers: expect.objectContaining({ 'API-Version': '2026-01' }),
      }),
    );
  });

  it("throws with the server's message when a 200 response carries no data", async () => {
    // Monday's rate-limit / auth-failure shape: HTTP 200 with no data and no errors array.
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ error_message: 'Rate limit exceeded', status_code: 429 }),
    } as Response);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
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
          { id: 'given', text: '150' },
        ],
      }],
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);

    const donor = await client.getDonorById('42', COLUMNS);

    expect(donor).toEqual({
      id: '42', email: 'a@b.com', membershipStatus: 'Active', membershipTier: 'Standard',
      memberSince: '2026-01-01', memberUntil: '', addr1: '1 Main St', city: 'San Jose',
      state: 'CA', zip: '95110', totalGiven: '150',
    });
  });

  it('returns null when the item no longer exists', async () => {
    const fetchFn = fakeFetch({ items: [] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    expect(await client.getDonorById('999', COLUMNS)).toBeNull();
  });

  it('throws on a GraphQL error response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ errors: [{ message: 'board not found' }] }),
    } as Response);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await expect(client.getDonorById('42', COLUMNS)).rejects.toThrow('monday: board not found');
  });
});

describe('HttpMondayClient.createCampaignItem', () => {
  it('returns the new item id', async () => {
    const fetchFn = fakeFetch({ create_item: { id: 'new-item' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    expect(await client.createCampaignItem(123, 'Newsletter')).toBe('new-item');
  });
});

describe('HttpMondayClient.renameItem', () => {
  it('sends the new name via the "name" pseudo-column', async () => {
    const fetchFn = fakeFetch({ change_simple_column_value: { id: 'item1' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await client.archiveItem('item1');
    expect(fetchFn).toHaveBeenCalled();
  });
});

describe('HttpMondayClient.findItemIdByEmail', () => {
  it('returns the matching item id', async () => {
    const fetchFn = fakeFetch({ items_page_by_column_values: { items: [{ id: '42' }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    expect(await client.findItemIdByEmail(123, 'email', 'nobody@b.com')).toBeNull();
  });

  it('does not issue the fallback query when the exact match hits', async () => {
    const fetchFn = fakeFetch({ items_page_by_column_values: { items: [{ id: '42' }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    expect(await client.findItemIdByEmail(123, 'email', 'a@b.com')).toBe('42');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('HttpMondayClient.setConnectColumn', () => {
  it('writes the full linked-item-ids set as JSON', async () => {
    const fetchFn = fakeFetch({ change_column_value: { id: '42' } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await client.setConnectColumn(123, '42', 'campaigns', ['1', '2']);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.monday.com/v2',
      expect.objectContaining({ body: expect.stringContaining('"item_ids\\":[1,2]') }),
    );
  });
});
