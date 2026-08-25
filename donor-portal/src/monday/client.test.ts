import { describe, it, expect, vi } from 'vitest';
import { HttpMondayClient } from './client';
import type { MondayColumns } from '../types';

const columns: MondayColumns = {
  donorEmail: 'email_col',
  membershipStatus: 'status_col',
  membershipTier: 'tier_col',
  dollarDonated: 'donated_col',
  donationDonorLink: 'link_col',
  donationAmount: 'amount_col',
  donationDate: 'date_col',
  donationDescription: 'desc_col',
  discountOffered: 'offer_col',
  discountActive: 'active_col',
  donorAddress: 'addr_col',
  donorPhone: 'phone_col',
  membershipExpiry: 'expiry_col',
  preferredLanguage: 'lang_col',
  volunteerDonorLink: 'vol_link_col',
  volunteerHours: 'vol_hours_col',
  volunteerDate: 'vol_date_col',
  volunteerJob: 'vol_job_col',
  volunteerStatus: 'vol_status_col',
};

function fetchReturning(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
}

function makeClient(payload: unknown): HttpMondayClient {
  return new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchReturning(payload));
}

function makeCapturingClient(onBody: (body: { query: string; variables: Record<string, unknown> }) => void): HttpMondayClient {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    onBody(JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> });
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { create_item: { id: '1' } } }),
    };
  });
  return new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);
}

describe('HttpMondayClient.findDonorsByEmail', () => {
  it('returns every matching donor item', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [{ items_page: { items: [{ id: '1', name: 'Jane' }, { id: '2', name: 'Jane Also' }] } }],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);

    const matches = await client.findDonorsByEmail('shared@example.org');

    expect(matches).toEqual([
      { id: '1', name: 'Jane', preferredLanguage: '' },
      { id: '2', name: 'Jane Also', preferredLanguage: '' },
    ]);
  });

  it('returns an empty array when nothing matches', async () => {
    const fetchMock = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);

    expect(await client.findDonorsByEmail('nobody@example.org')).toEqual([]);
  });

  it('passes a GraphQL-breaking email through as data, not interpolated into the query string', async () => {
    const fetchMock = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);
    const maliciousEmail = 'x" ], rules: [{ column_id: "y", compare_value: ["z';

    await client.findDonorsByEmail(maliciousEmail);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };

    // The value must travel as a variable, not get spliced into the query text.
    expect(body.variables.email).toBe(maliciousEmail);
    expect(body.query).not.toContain(maliciousEmail);
    expect(body.query).toContain('$email');
  });

  it('includes preferredLanguage in the matched donors when the column is configured', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [
          {
            items_page: {
              items: [{ id: '1', name: 'Jane', column_values: [{ id: 'lang_col', text: 'Spanish' }] }],
            },
          },
        ],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);

    const matches = await client.findDonorsByEmail('jane@example.org');

    expect(matches).toEqual([{ id: '1', name: 'Jane', preferredLanguage: 'Spanish' }]);
  });

  it('omits the placeholder preferredLanguage column id from the outgoing query (and returns "")', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { boards: [{ items_page: { items: [{ id: '1', name: 'Jane' }] } }] },
        }),
      };
    });
    const placeholderColumns: MondayColumns = { ...columns, preferredLanguage: 'REPLACE_WITH_COLUMN_ID' };
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, 3, fetchMock);

    const matches = await client.findDonorsByEmail('jane@example.org');

    expect(captured).not.toBeNull();
    expect(captured!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
    expect(matches).toEqual([{ id: '1', name: 'Jane', preferredLanguage: '' }]);
  });
});

describe('HttpMondayClient.getDonorPortalData', () => {
  it('combines the donor item fields with its linked donations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                id: 'donor-1',
                name: 'Jane Donor',
                column_values: [
                  { id: 'status_col', text: 'Active' },
                  { id: 'tier_col', text: 'Member' },
                  { id: 'donated_col', text: '500' },
                  { id: 'expiry_col', text: '2026-12-31' },
                ],
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            boards: [
              {
                items_page: {
                  cursor: null,
                  items: [
                    {
                      id: 'donation-1',
                      column_values: [
                        { id: 'amount_col', text: '100' },
                        { id: 'date_col', text: '2026-01-01' },
                        { id: 'desc_col', text: 'Annual gift' },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        }),
      });

    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);

    const data = await client.getDonorPortalData('donor-1');

    expect(data).toEqual({
      id: 'donor-1',
      name: 'Jane Donor',
      membershipStatus: 'Active',
      membershipTier: 'Member',
      totalDonated: '500',
      donations: [{ amount: '100', date: '2026-01-01', description: 'Annual gift' }],
      membershipExpiry: '2026-12-31',
    });
  });

  it('omits the placeholder membershipExpiry column id from the outgoing query', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              items: [
                {
                  id: 'donor-1',
                  name: 'Jane Donor',
                  column_values: [
                    { id: 'status_col', text: 'Active' },
                    { id: 'tier_col', text: 'Member' },
                    { id: 'donated_col', text: '500' },
                  ],
                },
              ],
            },
          }),
        };
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } }),
      });
    const placeholderColumns: MondayColumns = { ...columns, membershipExpiry: 'REPLACE_WITH_COLUMN_ID' };
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, 3, fetchMock);

    const data = await client.getDonorPortalData('donor-1');

    expect(captured).not.toBeNull();
    expect(captured!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
    // No downstream change needed: columnText() already returns '' for a column not present in
    // the response, matching the existing "no expiry" convention.
    expect(data.membershipExpiry).toBe('');
  });
});

describe('HttpMondayClient.getDiscountOrganizations', () => {
  it('returns only organizations with an active discount', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [
          {
            items_page: {
              cursor: null,
              items: [
                { id: 'org-1', name: 'Local Bikes', column_values: [{ id: 'offer_col', text: '10% off' }] },
              ],
            },
          },
        ],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);

    const orgs = await client.getDiscountOrganizations();

    expect(orgs).toEqual([{ name: 'Local Bikes', discountOffered: '10% off' }]);
  });
});

describe('HttpMondayClient.getVolunteerShiftsForDonor', () => {
  it('returns every shift linked to the donor, reading the volunteer columns', async () => {
    const client = makeClient({
      data: {
        boards: [
          {
            items_page: {
              cursor: null,
              items: [
                {
                  id: 'shift-1',
                  column_values: [
                    { id: 'vol_hours_col', text: '3.5' },
                    { id: 'vol_date_col', text: '2026-05-02' },
                    { id: 'vol_job_col', text: 'Bike Valet' },
                    { id: 'vol_status_col', text: 'Completed' },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    const shifts = await client.getVolunteerShiftsForDonor('donor-1');

    expect(shifts).toEqual([{ hours: '3.5', date: '2026-05-02', job: 'Bike Valet', status: 'Completed' }]);
  });

  it('follows the pagination cursor across pages', async () => {
    const item = (id: string, date: string) => ({
      id,
      column_values: [
        { id: 'vol_hours_col', text: '2' },
        { id: 'vol_date_col', text: date },
        { id: 'vol_job_col', text: 'Tabling' },
        { id: 'vol_status_col', text: 'Completed' },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { boards: [{ items_page: { cursor: 'next-page', items: [item('shift-1', '2026-01-10')] } }] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: { next_items_page: { cursor: null, items: [item('shift-2', '2026-02-11')] } },
        }),
      });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);

    const shifts = await client.getVolunteerShiftsForDonor('donor-1');

    expect(shifts.map((s) => s.date)).toEqual(['2026-01-10', '2026-02-11']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('passes the donor item id as a GraphQL variable, not interpolated into the query', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } }),
      };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);

    await client.getVolunteerShiftsForDonor('donor-1');

    expect(captured).not.toBeNull();
    expect(captured!.variables.donorItemId).toBe('donor-1');
    expect(captured!.variables.boardId).toBe(3);
    expect(captured!.query).toContain('$donorItemId');
  });
});

describe('HttpMondayClient error handling', () => {
  it('throws on a non-OK HTTP response', async () => {
    const fetchMock = fetchReturning({}, false);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    const fetchMock = fetchReturning({ errors: [{ message: 'Board not found' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, 3, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/Board not found/);
  });
});

describe('HttpMondayClient.getDonorContactInfo', () => {
  it('reads name, email, address, and phone off the donor item', async () => {
    const client = makeClient({
      data: {
        items: [
          {
            id: 'donor-1',
            name: 'Jane Example',
            column_values: [
              { id: 'email_col', text: 'jane@example.org' },
              { id: 'addr_col', text: '1 Old St' },
              { id: 'phone_col', text: '555-0100' },
            ],
          },
        ],
      },
    });

    const info = await client.getDonorContactInfo('donor-1');

    expect(info).toEqual({
      id: 'donor-1',
      name: 'Jane Example',
      email: 'jane@example.org',
      address: '1 Old St',
      phone: '555-0100',
      preferredLanguage: '',
    });
  });

  it('throws when the donor item does not exist', async () => {
    const client = makeClient({ data: { items: [] } });
    await expect(client.getDonorContactInfo('missing')).rejects.toThrow('not found');
  });

  it('includes preferredLanguage alongside address/email/phone', async () => {
    const client = makeClient({
      data: {
        items: [
          {
            id: 'donor-1',
            name: 'Jane Example',
            column_values: [
              { id: 'email_col', text: 'jane@example.org' },
              { id: 'addr_col', text: '1 Old St' },
              { id: 'phone_col', text: '555-0100' },
              { id: 'lang_col', text: 'Spanish' },
            ],
          },
        ],
      },
    });

    const info = await client.getDonorContactInfo('donor-1');

    expect(info).toEqual({
      id: 'donor-1',
      name: 'Jane Example',
      email: 'jane@example.org',
      address: '1 Old St',
      phone: '555-0100',
      preferredLanguage: 'Spanish',
    });
  });

  it('omits the placeholder preferredLanguage column id from the outgoing query (and returns "")', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                id: 'donor-1',
                name: 'Jane Example',
                column_values: [
                  { id: 'email_col', text: 'jane@example.org' },
                  { id: 'addr_col', text: '1 Old St' },
                  { id: 'phone_col', text: '555-0100' },
                ],
              },
            ],
          },
        }),
      };
    });
    const placeholderColumns: MondayColumns = { ...columns, preferredLanguage: 'REPLACE_WITH_COLUMN_ID' };
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, 3, fetchMock);

    const info = await client.getDonorContactInfo('donor-1');

    expect(captured).not.toBeNull();
    expect(captured!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
    expect(info).toEqual({
      id: 'donor-1',
      name: 'Jane Example',
      email: 'jane@example.org',
      address: '1 Old St',
      phone: '555-0100',
      preferredLanguage: '',
    });
  });
});

describe('HttpMondayClient.createChangeRequestItem', () => {
  it('sends a create_item mutation with JSON column values and no interpolated user input', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const client = makeCapturingClient((body) => {
      captured = body;
    });

    await client.createChangeRequestItem({
      boardId: 123,
      columns: { donorLink: 'connect_1', field: 'text_1', oldValue: 'text_2', newValue: 'text_3', submittedAt: 'date_1' },
      itemName: 'Address change — Jane Example',
      donorItemId: '4567',
      fieldLabel: 'Address',
      oldValue: '1 Old St',
      newValue: '2 New "Ave"',
      submittedAtISO: '2026-08-24T10:15:30.000Z',
    });

    expect(captured).not.toBeNull();
    // User-sourced strings travel as variables, never inside the query text:
    expect(captured!.query).not.toContain('2 New');
    expect(captured!.variables.itemName).toBe('Address change — Jane Example');
    const columnValues = JSON.parse(captured!.variables.columnValues as string) as Record<string, unknown>;
    expect(columnValues.connect_1).toEqual({ item_ids: [4567] });
    expect(columnValues.text_1).toBe('Address');
    expect(columnValues.text_2).toBe('1 Old St');
    expect(columnValues.text_3).toBe('2 New "Ave"');
    expect(columnValues.date_1).toEqual({ date: '2026-08-24', time: '10:15:30' });
  });
});
