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
  donorEmailOptOut: 'check_email_opt',
  donorSmsOptOut: 'check_sms_opt',
  donorDoNotMail: 'check_no_mail',
  volunteerDonorLink: 'vol_link_col',
  volunteerHours: 'vol_hours_col',
  volunteerDate: 'vol_date_col',
  volunteerJob: 'vol_job_col',
  volunteerStatus: 'vol_status_col',
};

const pledgesCfg = {
  boardId: 777,
  columns: {
    donorLink: 'pledge_link_col',
    pledgedAmount: 'pledged_col',
    fulfilledAmount: 'fulfilled_col',
    status: 'pledge_status_col',
    dueDate: 'pledge_due_col',
  },
};

function fetchReturning(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
}

function makeClient(payload: unknown): HttpMondayClient {
  return new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchReturning(payload));
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
  return new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);
}

describe('HttpMondayClient.findDonorsByEmail', () => {
  it('returns every matching donor item', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [{ items_page: { items: [{ id: '1', name: 'Jane' }, { id: '2', name: 'Jane Also' }] } }],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

    const matches = await client.findDonorsByEmail('shared@example.org');

    expect(matches).toEqual([
      { id: '1', name: 'Jane', preferredLanguage: '' },
      { id: '2', name: 'Jane Also', preferredLanguage: '' },
    ]);
  });

  it('returns an empty array when nothing matches', async () => {
    const fetchMock = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

    expect(await client.findDonorsByEmail('nobody@example.org')).toEqual([]);
  });

  it('passes a GraphQL-breaking email through as data, not interpolated into the query string', async () => {
    const fetchMock = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, pledgesCfg, 3, fetchMock);

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

    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, pledgesCfg, 3, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

    const shifts = await client.getVolunteerShiftsForDonor('donor-1');

    expect(shifts.map((s) => s.date)).toEqual(['2026-01-10', '2026-02-11']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a config error (before any fetch) when the board id is null', async () => {
    const fetchMock = fetchReturning({ data: {} });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, null, fetchMock);

    await expect(client.getVolunteerShiftsForDonor('donor-1')).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a config error (before any fetch) when a volunteer column is still the placeholder', async () => {
    const fetchMock = fetchReturning({ data: {} });
    const placeholderColumns: MondayColumns = { ...columns, volunteerStatus: 'REPLACE_WITH_COLUMN_ID' };
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, pledgesCfg, 3, fetchMock);

    await expect(client.getVolunteerShiftsForDonor('donor-1')).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends pagination gracefully when next_items_page comes back null (expired cursor)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            boards: [
              {
                items_page: {
                  cursor: 'stale-cursor',
                  items: [
                    {
                      id: 'shift-1',
                      column_values: [
                        { id: 'vol_hours_col', text: '2' },
                        { id: 'vol_date_col', text: '2026-01-10' },
                        { id: 'vol_job_col', text: 'Tabling' },
                        { id: 'vol_status_col', text: 'Completed' },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { next_items_page: null } }) });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

    const shifts = await client.getVolunteerShiftsForDonor('donor-1');

    expect(shifts).toHaveLength(1);
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    const fetchMock = fetchReturning({ errors: [{ message: 'Board not found' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);
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
      emailOptOut: false,
      smsOptOut: false,
      doNotMail: false,
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
      emailOptOut: false,
      smsOptOut: false,
      doNotMail: false,
    });
  });

  it('reads communication preference checkboxes off the donor item (Monday checkbox text: "v" = checked)', async () => {
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
              { id: 'check_email_opt', text: 'v' },
              { id: 'check_sms_opt', text: '' },
              { id: 'check_no_mail', text: 'v' },
            ],
          },
        ],
      },
    });

    const info = await client.getDonorContactInfo('donor-1');

    expect(info.emailOptOut).toBe(true);
    expect(info.smsOptOut).toBe(false);
    expect(info.doNotMail).toBe(true);
  });

  it('treats a configured preference column absent from the response as unchecked', async () => {
    const client = makeClient({
      data: {
        items: [
          {
            id: 'donor-1',
            name: 'Jane Example',
            column_values: [{ id: 'email_col', text: 'jane@example.org' }],
          },
        ],
      },
    });

    const info = await client.getDonorContactInfo('donor-1');

    expect(info.emailOptOut).toBe(false);
    expect(info.smsOptOut).toBe(false);
    expect(info.doNotMail).toBe(false);
  });

  it('returns null for preference fields whose columns are placeholders, omitting their ids from the query', async () => {
    let captured: { query: string } | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            items: [
              {
                id: 'donor-1',
                name: 'Jane Example',
                column_values: [{ id: 'email_col', text: 'jane@example.org' }],
              },
            ],
          },
        }),
      };
    });
    const placeholderPrefColumns: MondayColumns = {
      ...columns,
      donorEmailOptOut: 'REPLACE_WITH_COLUMN_ID',
      donorSmsOptOut: 'REPLACE_WITH_COLUMN_ID',
      donorDoNotMail: 'REPLACE_WITH_COLUMN_ID',
    };
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderPrefColumns, 999, 1, 2, pledgesCfg, 3, fetchMock);

    const info = await client.getDonorContactInfo('donor-1');

    expect(captured!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
    expect(info.emailOptOut).toBeNull();
    expect(info.smsOptOut).toBeNull();
    expect(info.doNotMail).toBeNull();
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, pledgesCfg, 3, fetchMock);

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
      emailOptOut: false,
      smsOptOut: false,
      doNotMail: false,
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

const eventParams = {
  boardId: 555,
  columns: { attendeeLink: 'connect_att', eventLink: 'connect_ev', attended: 'check_att' },
  eventDateColumnId: 'ev_date_col',
};

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe('HttpMondayClient.getEventRegistrationsForDonor', () => {
  it('joins registrations with their linked event name and date', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            boards: [
              {
                items_page: {
                  cursor: null,
                  items: [
                    {
                      id: 'reg-1',
                      name: 'Bike Summit registration',
                      column_values: [
                        { id: 'check_att', text: 'v' },
                        { id: 'connect_ev', text: 'Bike Summit 2026', linked_item_ids: ['ev-1'] },
                      ],
                    },
                    {
                      id: 'reg-2',
                      name: 'Gala registration',
                      column_values: [
                        { id: 'check_att', text: '' },
                        { id: 'connect_ev', text: 'Fall Gala', linked_item_ids: ['ev-2'] },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            items: [
              { id: 'ev-1', name: 'Bike Summit 2026', column_values: [{ id: 'ev_date_col', text: '2026-04-12' }] },
              { id: 'ev-2', name: 'Fall Gala', column_values: [{ id: 'ev_date_col', text: '2026-10-03' }] },
            ],
          },
        })
      );
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, null, null, fetchMock);

    const records = await client.getEventRegistrationsForDonor({ donorItemId: 'donor-1', ...eventParams });

    expect(records).toEqual([
      { registrationName: 'Bike Summit registration', eventName: 'Bike Summit 2026', eventDate: '2026-04-12', attended: true },
      { registrationName: 'Gala registration', eventName: 'Fall Gala', eventDate: '2026-10-03', attended: false },
    ]);
  });

  it('passes the donor item id as a GraphQL variable, never interpolated', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
      return jsonResponse({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } });
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, null, null, fetchMock);

    await client.getEventRegistrationsForDonor({ donorItemId: 'donor-9', ...eventParams });

    expect(captured).not.toBeNull();
    expect(captured!.variables.donorItemId).toBe('donor-9');
    expect(captured!.query).not.toContain('donor-9');
  });

  it('skips the events lookup entirely when the donor has no registrations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } }));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, null, null, fetchMock);

    expect(await client.getEventRegistrationsForDonor({ donorItemId: 'donor-1', ...eventParams })).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps a registration whose event link is empty, with blank event name and date', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: {
          boards: [
            {
              items_page: {
                cursor: null,
                items: [
                  {
                    id: 'reg-1',
                    name: 'Unlinked registration',
                    column_values: [
                      { id: 'check_att', text: '' },
                      { id: 'connect_ev', text: '', linked_item_ids: [] },
                    ],
                  },
                ],
              },
            },
          ],
        },
      })
    );
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, null, null, fetchMock);

    const records = await client.getEventRegistrationsForDonor({ donorItemId: 'donor-1', ...eventParams });

    expect(records).toEqual([{ registrationName: 'Unlinked registration', eventName: '', eventDate: '', attended: false }]);
    // No linked event ids means no second query to the Events board.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows the registrations cursor across pages', async () => {
    const regItem = (id: string, eventId: string) => ({
      id,
      name: `reg ${id}`,
      column_values: [
        { id: 'check_att', text: 'v' },
        { id: 'connect_ev', text: 'Event', linked_item_ids: [eventId] },
      ],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: { boards: [{ items_page: { cursor: 'page-2', items: [regItem('reg-1', 'ev-1')] } }] } })
      )
      .mockResolvedValueOnce(
        jsonResponse({ data: { next_items_page: { cursor: null, items: [regItem('reg-2', 'ev-1')] } } })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: { items: [{ id: 'ev-1', name: 'Big Ride', column_values: [{ id: 'ev_date_col', text: '2027-05-01' }] }] },
        })
      );
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, null, null, fetchMock);

    const records = await client.getEventRegistrationsForDonor({ donorItemId: 'donor-1', ...eventParams });

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.eventName === 'Big Ride' && r.eventDate === '2027-05-01')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('HttpMondayClient.getDonorNames', () => {
  it('returns id+name pairs from one query and skips the request entirely for no ids', async () => {
    const fetchMock = fetchReturning({ data: { items: [{ id: '1', name: 'Jane' }, { id: '2', name: 'Sam' }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

    expect(await client.getDonorNames(['1', '2'])).toEqual([
      { id: '1', name: 'Jane' },
      { id: '2', name: 'Sam' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(await client.getDonorNames([])).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('HttpMondayClient.getPledgesForDonor', () => {
  it('throws loudly when the pledges board is not configured', async () => {
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, null, 3, fetchReturning({}));
    await expect(client.getPledgesForDonor('4567')).rejects.toThrow(/pledges board is not configured/);
  });

  it('maps pledge items from the configured columns and passes donorItemId as a variable', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [
          {
            items_page: {
              cursor: null,
              items: [
                {
                  id: '10',
                  name: '2026 Annual Pledge',
                  column_values: [
                    { id: 'pledged_col', text: '$1,000.00' },
                    { id: 'fulfilled_col', text: '$400.00' },
                    { id: 'pledge_status_col', text: 'Active' },
                    { id: 'pledge_due_col', text: '2026-12-31' },
                  ],
                },
              ],
            },
          },
        ],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

    const pledges = await client.getPledgesForDonor('4567');

    expect(pledges).toEqual([
      { name: '2026 Annual Pledge', pledged: '$1,000.00', fulfilled: '$400.00', status: 'Active', dueDate: '2026-12-31' },
    ]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
    expect(body.variables.donorItemId).toBe('4567');
    expect(body.variables.boardId).toBe(777);
    expect(body.query).toContain('pledge_link_col');
    expect(body.query).not.toContain('4567');
  });

  it('follows the cursor across pages, same as donations', async () => {
    const page1 = {
      data: {
        boards: [
          {
            items_page: {
              cursor: 'next',
              items: [{ id: '10', name: 'P1', column_values: [{ id: 'pledged_col', text: '$1' }] }],
            },
          },
        ],
      },
    };
    const page2 = {
      data: {
        next_items_page: {
          cursor: null,
          items: [{ id: '11', name: 'P2', column_values: [{ id: 'pledged_col', text: '$2' }] }],
        },
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page1 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page2 });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, pledgesCfg, 3, fetchMock);

    const pledges = await client.getPledgesForDonor('4567');

    expect(pledges.map((p) => p.name)).toEqual(['P1', 'P2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
