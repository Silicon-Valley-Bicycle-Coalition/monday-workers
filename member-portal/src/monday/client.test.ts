import { describe, it, expect, vi } from 'vitest';
import { AmbiguousWriteError, HttpMondayClient, MONDAY_FETCH_TIMEOUT_MS } from './client';
import { MONDAY_API_VERSION } from './graphql';
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
  donationStatus: 'donation_status_col',
  discountOffered: 'offer_col',
  discountActive: 'active_col',
  donorAddress: 'addr_col',
  donorPhone: 'phone_col',
  membershipExpiry: 'expiry_col',
  preferredLanguage: 'lang_col',
  donorHouseholdEmail: 'household_col',
  donorEmailOptOut: 'check_email_opt',
  donorSmsOptOut: 'check_sms_opt',
  donorDoNotMail: 'check_no_mail',
  volunteerDonorLink: 'vol_link_col',
  volunteerHours: 'vol_hours_col',
  volunteerDate: 'vol_date_col',
  volunteerJob: 'vol_job_col',
  volunteerStatus: 'vol_status_col',
  donationMatchesGift: 'REPLACE_WITH_COLUMN_ID',
  donationMatchStatus: 'REPLACE_WITH_COLUMN_ID',
  donationMatchedBy: 'REPLACE_WITH_COLUMN_ID',
  donorDtdLink: 'REPLACE_WITH_COLUMN_ID',
  donorEmployer: 'employer_col',
  memberSince: 'since_col',
  memberType: 'member_type_col',
  donorEmailConsent: 'email_consent_col',
  donorHouseholdEmailConsent: 'household_consent_col',
};

// Mirrors config donations.countableStatuses — the Donations-board status labels that count as
// real gifts. Failed and Pending items must never reach portal history or letter totals.
const countableStatuses = ['Received', 'Received (Historical)'];
// No history floor by default; the floor's own tests build a variant with historyStartISO set.
const donationsCfg = { countableStatuses, historyStartISO: null };

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
  return new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchReturning(payload));
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
  return new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
}

// Issue GL#31: with no timeout, a hung Monday request held a dashboard render or a queue consumer
// indefinitely. Every request carries an AbortSignal.timeout, and a timeout surfaces as a
// monday-prefixed error the callers already log/retry on.
// An email column's column_value as findDonorsByEmail requests it.
function emailValue(address: string) {
  return { id: 'email_col', text: address, value: JSON.stringify({ email: address, text: address }) };
}

describe('HttpMondayClient request timeout', () => {
  it('passes an AbortSignal to every Monday fetch', async () => {
    const fetchFn = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchFn);

    await client.findDonorsByEmail('x@example.org');

    const init = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(MONDAY_FETCH_TIMEOUT_MS).toBe(15_000);
  });

  it('reports a timed-out request as a monday timeout error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchFn);

    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow('monday API: request timed out after 15000ms');
  });

  it("keeps other fetch failures' own message", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError('Network connection lost.'));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchFn);

    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow('Network connection lost.');
  });
});

// GL#35: the client runs on the canonical transport (src/monday/graphql.ts).
describe('HttpMondayClient transport', () => {
  it('makes exactly one request per call — no in-process retry on a page render', async () => {
    const fetchFn = vi.fn(async () => new Response('down', { status: 503 }));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchFn);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow('monday API: HTTP 503: down');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('sends the transport\'s single pinned API-Version (#39)', async () => {
    const fetchFn = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchFn);
    await client.findDonorsByEmail('x@example.org');
    expect(new Headers((fetchFn.mock.calls[0]![1] as RequestInit).headers).get('API-Version')).toBe(MONDAY_API_VERSION);
  });

  it('reports a change-request create that may have committed as an AmbiguousWriteError', async () => {
    const fetchFn = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchFn);
    const columnsCfg = { donorLink: 'd', field: 'f', oldValue: 'o', newValue: 'n', submittedAt: 's' };
    await expect(client.createChangeRequestItem({
      boardId: 1, columns: columnsCfg as never, itemName: 'x', donorItemId: '1',
      fieldLabel: 'Email', oldValue: 'a', newValue: 'b', submittedAtISO: '2026-09-29T12:00:00Z',
    })).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('HttpMondayClient.findDonorsByEmail', () => {
  it('returns every matching donor item', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [
          {
            items_page: {
              items: [
                { id: '1', name: 'Jane', column_values: [emailValue('shared@example.org')] },
                { id: '2', name: 'Jane Also', column_values: [emailValue('Shared@Example.org')] },
              ],
            },
          },
        ],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const matches = await client.findDonorsByEmail('shared@example.org');

    expect(matches).toEqual([
      { id: '1', name: 'Jane', preferredLanguage: '', matchedPersonal: true },
      { id: '2', name: 'Jane Also', preferredLanguage: '', matchedPersonal: true },
    ]);
  });

  it('returns an empty array when nothing matches', async () => {
    const fetchMock = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    expect(await client.findDonorsByEmail('nobody@example.org')).toEqual([]);
  });

  it('passes a GraphQL-breaking email through as data, not interpolated into the query string', async () => {
    const fetchMock = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
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
              items: [{ id: '1', name: 'Jane', column_values: [emailValue('jane@example.org'), { id: 'lang_col', text: 'Spanish' }] }],
            },
          },
        ],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const matches = await client.findDonorsByEmail('jane@example.org');

    expect(matches).toEqual([{ id: '1', name: 'Jane', preferredLanguage: 'Spanish', matchedPersonal: true }]);
  });

  it('omits the placeholder preferredLanguage column id from the outgoing query (and returns "")', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: { boards: [{ items_page: { items: [{ id: '1', name: 'Jane', column_values: [emailValue('jane@example.org')] }] } }] },
        }),
      };
    });
    const placeholderColumns: MondayColumns = { ...columns, preferredLanguage: 'REPLACE_WITH_COLUMN_ID' };
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const matches = await client.findDonorsByEmail('jane@example.org');

    expect(captured).not.toBeNull();
    expect(captured!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
    expect(matches).toEqual([{ id: '1', name: 'Jane', preferredLanguage: '', matchedPersonal: true }]);
  });

  describe('Household Email', () => {
    const capture = (items: unknown[]) => {
      const calls: { query: string; variables: Record<string, unknown> }[] = [];
      const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        calls.push(JSON.parse(init.body as string));
        return { ok: true, status: 200, json: async () => ({ data: { boards: [{ items_page: { items } }] } }) };
      });
      return { calls, fetchMock };
    };
    const make = (cols: MondayColumns, fetchMock: ReturnType<typeof fetchReturning>) =>
      new HttpMondayClient('https://api.monday.com/v2', 'token', cols, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    it('queries both email columns with operator or when donorHouseholdEmail is configured', async () => {
      const { calls, fetchMock } = capture([]);
      await make(columns, fetchMock).findDonorsByEmail('jane@example.org');
      const q = calls[0]!.query;
      expect(q).toContain('column_id: "email_col", compare_value: [$email], operator: any_of');
      expect(q).toContain('column_id: "household_col", compare_value: [$email], operator: any_of');
      expect(q).toContain('operator: or');
      expect(q).toContain('"household_col"');
      expect(calls[0]!.variables.email).toBe('jane@example.org');
    });

    it('returns an item whose Household Email equals the address, ignoring case and whitespace', async () => {
      const { fetchMock } = capture([
        { id: '1', name: 'Jane', column_values: [{ id: 'household_col', text: '  Family@Example.org ', value: null }] },
      ]);
      const matches = await make(columns, fetchMock).findDonorsByEmail('family@example.org');
      expect(matches).toEqual([{ id: '1', name: 'Jane', preferredLanguage: '', matchedPersonal: false }]);
    });

    it('drops an item matching neither column exactly (Monday fuzzy hit)', async () => {
      const { fetchMock } = capture([
        { id: '1', name: 'Jane', column_values: [emailValue('other@example.org'), { id: 'household_col', text: 'another@example.org', value: null }] },
      ]);
      expect(await make(columns, fetchMock).findDonorsByEmail('family@example.org')).toEqual([]);
    });

    it('returns both items sharing a Household Email', async () => {
      const { fetchMock } = capture([
        { id: '1', name: 'Jane', column_values: [{ id: 'household_col', text: 'family@example.org', value: null }] },
        { id: '2', name: 'Joe', column_values: [{ id: 'household_col', text: 'family@example.org', value: null }] },
      ]);
      const matches = await make(columns, fetchMock).findDonorsByEmail('family@example.org');
      expect(matches.map((m) => m.id)).toEqual(['1', '2']);
    });

    it('sends the single Personal Email rule, no operator and no household id, while a placeholder', async () => {
      const { calls, fetchMock } = capture([]);
      await make({ ...columns, donorHouseholdEmail: 'REPLACE_WITH_COLUMN_ID' }, fetchMock).findDonorsByEmail('jane@example.org');
      const q = calls[0]!.query;
      expect(q).toContain('rules: [{ column_id: "email_col", compare_value: [$email], operator: any_of }]');
      expect(q).not.toContain('operator: or');
      expect(q).not.toContain('REPLACE_WITH_COLUMN_ID');
      expect(q).toContain('column_values(ids: ["email_col","lang_col"])');
    });
  });

  // Issue GL#62: whatever Monday's filter returns, only an exact (case-insensitive) address match
  // may get a login link.
  it('drops items whose address is not exactly the submitted one', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [
          {
            items_page: {
              items: [
                { id: '1', name: 'Exact', column_values: [emailValue(' JANE@example.org ')] },
                { id: '2', name: 'Superstring', column_values: [emailValue('mary.jane@example.org')] },
                { id: '3', name: 'Other domain', column_values: [emailValue('jane@example.org.evil')] },
                { id: '4', name: 'No email', column_values: [] },
              ],
            },
          },
        ],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    expect((await client.findDonorsByEmail('jane@example.org')).map((m) => m.id)).toEqual(['1']);
  });

  it("matches on an email column's address, not its display label", async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [
          {
            items_page: {
              items: [
                { id: '1', name: 'Labelled', column_values: [{ id: 'email_col', text: 'Jane (work)', value: JSON.stringify({ email: 'jane@example.org', text: 'Jane (work)' }) }] },
                { id: '2', name: 'Label only', column_values: [{ id: 'email_col', text: 'jane@example.org', value: JSON.stringify({ email: 'other@example.org', text: 'jane@example.org' }) }] },
              ],
            },
          },
        ],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    expect((await client.findDonorsByEmail('jane@example.org')).map((m) => m.id)).toEqual(['1']);
  });

  it('reads a plain text column, and falls back to text when value is missing', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [
          {
            items_page: {
              items: [
                { id: '1', name: 'Text column', column_values: [{ id: 'email_col', text: 'jane@example.org', value: '"jane@example.org"' }] },
                { id: '2', name: 'No value', column_values: [{ id: 'email_col', text: 'jane@example.org' }] },
              ],
            },
          },
        ],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    expect((await client.findDonorsByEmail('jane@example.org')).map((m) => m.id)).toEqual(['1', '2']);
  });
});

describe('HttpMondayClient.getMemberPortalData', () => {
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
                        { id: 'donation_status_col', text: 'Received' },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        }),
      });

    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const data = await client.getMemberPortalData('donor-1');

    expect(data).toEqual({
      id: 'donor-1',
      name: 'Jane Donor',
      membershipStatus: 'Active',
      membershipTier: 'Member',
      totalDonated: '500',
      donations: [{ amount: '100', date: '2026-01-01', description: 'Annual gift' }],
      membershipExpiry: '2026-12-31',
      memberSince: '',
      memberType: '',
    });
  });

  it('requests memberSince and memberType when configured and returns their text', async () => {
    let captured: { query: string } | null = null;
    const fetchMock = vi.fn().mockImplementationOnce(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string };
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
                  { id: 'since_col', text: '2026-11-11' },
                  { id: 'member_type_col', text: 'New' },
                ],
              },
            ],
          },
        }),
      };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
    const data = await client.getMemberPortalData('donor-1', { includeDonations: false });
    expect(captured!.query).toContain('since_col');
    expect(captured!.query).toContain('member_type_col');
    expect(data.memberSince).toBe('2026-11-11');
    expect(data.memberType).toBe('New');
  });

  it('omits placeholder memberSince and memberType column ids and returns empty strings', async () => {
    let captured: { query: string } | null = null;
    const fetchMock = vi.fn().mockImplementationOnce(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { items: [{ id: 'donor-1', name: 'Jane Donor', column_values: [{ id: 'status_col', text: 'Active' }] }] } }),
      };
    });
    const gated: MondayColumns = { ...columns, memberSince: 'REPLACE_WITH_COLUMN_ID', memberType: 'REPLACE_WITH_COLUMN_ID' };
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', gated, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
    const data = await client.getMemberPortalData('donor-1', { includeDonations: false });
    expect(captured!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
    expect(data.memberSince).toBe('');
    expect(data.memberType).toBe('');
  });

  it('never queries the Donations board when includeDonations is false, returning an empty, unloaded history', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({
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
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const data = await client.getMemberPortalData('donor-1', { includeDonations: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(data).toMatchObject({ id: 'donor-1', name: 'Jane Donor', membershipStatus: 'Active', donations: [], totalDonated: '' });
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const data = await client.getMemberPortalData('donor-1');

    expect(captured).not.toBeNull();
    expect(captured!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
    // No downstream change needed: columnText() already returns '' for a column not present in
    // the response, matching the existing "no expiry" convention.
    expect(data.membershipExpiry).toBe('');
  });

  // GL#99: the donations query needs only the donor item id, so both reads go out before either
  // answers — one Monday round trip per page instead of two.
  it('issues the donor and donations reads concurrently', async () => {
    const pending: { query: string; resolve: (body: unknown) => void }[] = [];
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((resolve) => {
          const { query } = JSON.parse(init.body as string) as { query: string };
          pending.push({ query, resolve: (body) => resolve({ ok: true, status: 200, json: async () => body }) });
        })
    );
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const result = client.getMemberPortalData('donor-1');
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    pending.find((p) => p.query.includes('items(ids'))!.resolve({
      data: { items: [{ id: 'donor-1', name: 'Jane Donor', column_values: [{ id: 'donated_col', text: '100' }] }] },
    });
    pending.find((p) => p.query.includes('items_page'))!.resolve({
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
                    { id: 'donation_status_col', text: 'Received' },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    const data = await result;
    expect(data.name).toBe('Jane Donor');
    expect(data.donations.map((d) => d.amount)).toEqual(['100']);
  });

  it('reports the donor-not-found error even when the donations read also fails', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      if (query.includes('items_page')) throw new Error('network down');
      return { ok: true, status: 200, json: async () => ({ data: { items: [] } }) };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 1, fetchMock);

    await expect(client.getMemberPortalData('donor-1')).rejects.toThrow('monday: donor item "donor-1" not found');
  });

  it('fails when the donations read fails, even though the donor item loaded', async () => {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      if (query.includes('items_page')) return { ok: true, status: 200, json: async () => ({ errors: [{ message: 'boom' }] }) };
      return { ok: true, status: 200, json: async () => ({ data: { items: [{ id: 'donor-1', name: 'Jane', column_values: [] }] } }) };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 1, fetchMock);

    await expect(client.getMemberPortalData('donor-1')).rejects.toThrow(/boom/);
  });
});

describe('HttpMondayClient donation status filtering', () => {
  const donorItemResponse = {
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

  const donationItem = (id: string, status: string, amount: string) => ({
    id,
    column_values: [
      { id: 'amount_col', text: amount },
      { id: 'date_col', text: '2025-03-01' },
      { id: 'desc_col', text: 'gift' },
      { id: 'donation_status_col', text: status },
    ],
  });

  it('excludes Failed and Pending donations, keeping Received and Received (Historical)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(donorItemResponse)
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
                    donationItem('d-1', 'Received', '100'),
                    donationItem('d-2', 'Failed', '500'),
                    donationItem('d-3', 'Pending', '250'),
                    donationItem('d-4', 'Received (Historical)', '75'),
                  ],
                },
              },
            ],
          },
        }),
      });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const data = await client.getMemberPortalData('donor-1');

    expect(data.donations.map((d) => d.amount)).toEqual(['100', '75']);
  });

  const donationsPage = (items: unknown[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { boards: [{ items_page: { cursor: null, items } }] } }),
  });
  const datedItem = (id: string, date: string, amount: string) => ({
    id,
    column_values: [
      { id: 'amount_col', text: amount },
      { id: 'date_col', text: date },
      { id: 'desc_col', text: 'gift' },
      { id: 'donation_status_col', text: 'Received' },
    ],
  });
  const flooredCfg = { countableStatuses, historyStartISO: '2026-01-01' };

  it('drops gifts dated before historyStartISO, and undated gifts, when a floor is set', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(donorItemResponse)
      .mockResolvedValueOnce(
        donationsPage([
          datedItem('d-1', '2025-12-31', '10'),
          datedItem('d-2', '2026-01-01', '20'),
          datedItem('d-3', '', '30'),
          datedItem('d-4', '2026-06-15', '40'),
        ])
      );
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, flooredCfg, pledgesCfg, 3, fetchMock);

    const data = await client.getMemberPortalData('donor-1');

    expect(data.donations.map((d) => d.amount)).toEqual(['20', '40']);
  });

  it('keeps undated gifts when there is no floor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(donorItemResponse)
      .mockResolvedValueOnce(donationsPage([datedItem('d-1', '', '30'), datedItem('d-2', '2019-05-05', '5')]));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const data = await client.getMemberPortalData('donor-1');

    expect(data.donations.map((d) => d.amount)).toEqual(['30', '5']);
  });

  it('reports totalDonated as the sum of the kept gifts when a floor is set, not the rollup column', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(donorItemResponse) // donated_col: 500 lifetime
      .mockResolvedValueOnce(
        donationsPage([datedItem('d-1', '2025-12-31', '400'), datedItem('d-2', '2026-02-01', '1,250.50'), datedItem('d-3', '2026-03-01', '49.50')])
      );
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, flooredCfg, pledgesCfg, 3, fetchMock);

    const data = await client.getMemberPortalData('donor-1');

    expect(data.totalDonated).toBe('1300');
  });

  it('reports totalDonated from the rollup column when there is no floor', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(donorItemResponse)
      .mockResolvedValueOnce(donationsPage([datedItem('d-1', '2025-12-31', '400')]));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const data = await client.getMemberPortalData('donor-1');

    expect(data.totalDonated).toBe('500');
  });

  it('requests the donation status column id in the donations query', async () => {
    const bodies: { query: string }[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => donorItemResponse)
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string) as { query: string });
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } }),
        };
      });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    await client.getMemberPortalData('donor-1');

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.query).toContain('donation_status_col');
  });
});

describe('HttpMondayClient.getDiscountOrganizations pagination', () => {
  // Issue GL#31: the query asked for `cursor` but never used it, silently dropping every active
  // discount past the first 500.
  it('follows the cursor past the first page', async () => {
    const bodies: { query: string; variables: Record<string, unknown> }[] = [];
    const pages = [
      {
        data: {
          boards: [
            {
              items_page: {
                cursor: 'cursor-1',
                items: [{ id: 'org-1', name: 'Local Bikes', column_values: [{ id: 'offer_col', text: '10% off' }] }],
              },
            },
          ],
        },
      },
      {
        data: {
          next_items_page: {
            cursor: null,
            items: [{ id: 'org-2', name: 'Café Velo', column_values: [{ id: 'offer_col', text: 'Free coffee' }] }],
          },
        },
      },
    ];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return { ok: true, status: 200, json: async () => pages[bodies.length - 1] };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const orgs = await client.getDiscountOrganizations();

    expect(orgs).toEqual([
      { name: 'Local Bikes', discountOffered: '10% off' },
      { name: 'Café Velo', discountOffered: 'Free coffee' },
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.query).toContain('next_items_page');
    expect(bodies[1]!.query).toContain('offer_col');
    expect(bodies[1]!.variables).toEqual({ cursor: 'cursor-1' });
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

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

  // GL#115: one person's Shift 1 and Shift 2 rows for one event read the same without the ticket type.
  describe('with monday.columns.volunteerTicketType configured', () => {
    const shiftsResponse = (rows: { job: string; ticket: string }[]) => ({
      data: {
        boards: [
          {
            items_page: {
              cursor: null,
              items: rows.map((r, i) => ({
                id: `shift-${i}`,
                column_values: [
                  { id: 'vol_hours_col', text: '' },
                  { id: 'vol_date_col', text: '2026-05-02' },
                  { id: 'vol_job_col', text: r.job },
                  { id: 'vol_status_col', text: 'Completed' },
                  { id: 'vol_ticket_col', text: r.ticket },
                ],
              })),
            },
          },
        ],
      },
    });
    const ticketColumns: MondayColumns = { ...columns, volunteerTicketType: 'vol_ticket_col' };

    it('appends the ticket type to the job and asks Monday for the column', async () => {
      const fetchMock = fetchReturning(shiftsResponse([
        { job: 'Bike to Work Day', ticket: 'Shift 1' },
        { job: 'Bike to Work Day', ticket: 'Shift 2' },
      ]));
      const client = new HttpMondayClient('https://api.monday.com/v2', 'token', ticketColumns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

      const shifts = await client.getVolunteerShiftsForDonor('donor-1');

      expect(shifts.map((s) => s.job)).toEqual(['Bike to Work Day — Shift 1', 'Bike to Work Day — Shift 2']);
      expect(JSON.stringify(fetchMock.mock.calls[0])).toContain('vol_ticket_col');
    });

    it('shows the job alone when the ticket type is blank or repeats it, and the ticket type alone when the job is blank', async () => {
      const fetchMock = fetchReturning(shiftsResponse([
        { job: 'Tabling', ticket: '' },
        { job: 'Bike Valet', ticket: 'bike valet' },
        { job: '', ticket: 'Shift 1' },
      ]));
      const client = new HttpMondayClient('https://api.monday.com/v2', 'token', ticketColumns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

      const shifts = await client.getVolunteerShiftsForDonor('donor-1');

      expect(shifts.map((s) => s.job)).toEqual(['Tabling', 'Bike Valet', 'Shift 1']);
    });

    it('ignores a placeholder ticket type column rather than failing the read', async () => {
      const fetchMock = fetchReturning(shiftsResponse([{ job: 'Tabling', ticket: 'Shift 1' }]));
      const placeholder: MondayColumns = { ...columns, volunteerTicketType: 'REPLACE_WITH_COLUMN_ID' };
      const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholder, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

      const shifts = await client.getVolunteerShiftsForDonor('donor-1');

      expect(shifts.map((s) => s.job)).toEqual(['Tabling']);
      expect(JSON.stringify(fetchMock.mock.calls[0])).not.toContain('REPLACE_WITH_COLUMN_ID');
    });
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const shifts = await client.getVolunteerShiftsForDonor('donor-1');

    expect(shifts.map((s) => s.date)).toEqual(['2026-01-10', '2026-02-11']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws a config error (before any fetch) when the board id is null', async () => {
    const fetchMock = fetchReturning({ data: {} });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, null, fetchMock);

    await expect(client.getVolunteerShiftsForDonor('donor-1')).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws a config error (before any fetch) when a volunteer column is still the placeholder', async () => {
    const fetchMock = fetchReturning({ data: {} });
    const placeholderColumns: MondayColumns = { ...columns, volunteerStatus: 'REPLACE_WITH_COLUMN_ID' };
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    await client.getVolunteerShiftsForDonor('4567');

    expect(captured).not.toBeNull();
    // Sent as a number, not the raw id string — a connect-board column's compare_value only
    // matches a linked item id when it's a JSON number (verified live 2026-09-20).
    expect(captured!.variables.donorItemId).toBe(4567);
    expect(captured!.variables.boardId).toBe(3);
    expect(captured!.query).toContain('$donorItemId');
  });
});

describe('HttpMondayClient error handling', () => {
  it('throws on a non-OK HTTP response', async () => {
    const fetchMock = fetchReturning({}, false);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    const fetchMock = fetchReturning({ errors: [{ message: 'Board not found' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/Board not found/);
  });

  it('throws the server message when a 200 response carries no data (Monday rate-limit/auth shape)', async () => {
    // Monday's rate-limit and auth failures return HTTP 200 with only error_message/status_code
    // and NO data field — without a guard that surfaces as "Cannot read properties of undefined"
    // somewhere downstream instead of the server's actual message.
    const fetchMock = fetchReturning({ error_message: 'Rate limit exceeded', status_code: 429 });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/Rate limit exceeded/);
  });

  it('throws with the raw payload when a no-data response has no error_message either', async () => {
    const fetchMock = fetchReturning({ status_code: 500 });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/no data/);
  });

  it('pins the Monday API version via the API-Version header on every request', async () => {
    let capturedHeaders: Record<string, string> | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return { ok: true, status: 200, json: async () => ({ data: { boards: [{ items_page: { items: [] } }] } }) };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    await client.findDonorsByEmail('x@example.org');

    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!['API-Version']).toBe(MONDAY_API_VERSION);
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
      employer: '',
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
      employer: '',
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderPrefColumns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', placeholderColumns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

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
      employer: '',
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

describe('HttpMondayClient.findChangeRequestItem', () => {
  function clientReturning(items: { id: string; name: string }[], onBody?: (body: { query: string; variables: Record<string, unknown> }) => void) {
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      onBody?.(JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> });
      return { ok: true, status: 200, json: async () => ({ data: { items_page_by_column_values: { items } } }) };
    });
    return new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
  }

  it('queries the board by exact item name, passed as a variable', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const client = clientReturning([{ id: '55', name: 'Address change — Jane "Q" Example (#42)' }], (body) => {
      captured = body;
    });

    const id = await client.findChangeRequestItem({ boardId: 123, itemName: 'Address change — Jane "Q" Example (#42)' });

    expect(id).toBe('55');
    expect(captured!.query).toContain('items_page_by_column_values');
    expect(captured!.query).not.toContain('Jane');
    expect(captured!.variables).toEqual({
      boardId: 123,
      columns: [{ column_id: 'name', column_values: ['Address change — Jane "Q" Example (#42)'] }],
    });
  });

  it('returns null when nothing matches', async () => {
    expect(await clientReturning([]).findChangeRequestItem({ boardId: 1, itemName: 'x (#1)' })).toBeNull();
  });

  it('ignores a returned item whose name is not an exact match', async () => {
    const client = clientReturning([{ id: '9', name: 'Address change — Jane Example (#421)' }]);
    expect(await client.findChangeRequestItem({ boardId: 1, itemName: 'Address change — Jane Example (#42)' })).toBeNull();
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

    await client.getEventRegistrationsForDonor({ donorItemId: '4589', ...eventParams });

    expect(captured).not.toBeNull();
    // Sent as a number, not the raw id string — same connect-board compare_value fix as
    // fetchItemsLinkedToDonor's other callers (verified live 2026-09-20).
    expect(captured!.variables.donorItemId).toBe(4589);
    expect(captured!.query).not.toContain('4589');
  });

  it('skips the events lookup entirely when the donor has no registrations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } }));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

    const records = await client.getEventRegistrationsForDonor({ donorItemId: 'donor-1', ...eventParams });

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.eventName === 'Big Ride' && r.eventDate === '2027-05-01')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('HttpMondayClient.getDonorNames', () => {
  it('returns id+name pairs from one query and skips the request entirely for no ids', async () => {
    const fetchMock = fetchReturning({ data: { items: [{ id: '1', name: 'Jane' }, { id: '2', name: 'Sam' }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, 3, fetchReturning({}));
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const pledges = await client.getPledgesForDonor('4567');

    expect(pledges).toEqual([
      { name: '2026 Annual Pledge', pledged: '$1,000.00', fulfilled: '$400.00', status: 'Active', dueDate: '2026-12-31' },
    ]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
    // Sent as a number, not the raw id string (verified live 2026-09-20).
    expect(body.variables.donorItemId).toBe(4567);
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);

    const pledges = await client.getPledgesForDonor('4567');

    expect(pledges.map((p) => p.name)).toEqual(['P1', 'P2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

const letterCronColumns = {
  autoSend: 'checkbox_1',
  startDate: 'date_2',
  bodyTemplate: 'long_text_1',
  bodyTemplatesByLocale: { es: 'long_text_es', 'zh-Hant': 'long_text_zht' } as const,
};

describe('HttpMondayClient.getLetterSettings', () => {
  it('parses the settings item into autoSend/startDate/bodyTemplate', async () => {
    const client = makeClient({
      data: {
        boards: [
          {
            items_page: {
              items: [
                {
                  id: '11',
                  name: 'Letter emails',
                  column_values: [
                    { id: 'checkbox_1', text: 'v', checked: true },
                    { id: 'date_2', text: '2027-01-05' },
                    { id: 'long_text_1', text: 'Hi {{donorName}}, your {{year}} letter: {{loginUrl}}' },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    expect(await client.getLetterSettings({ boardId: 456, columns: letterCronColumns, settingsItemName: 'Letter emails' })).toEqual({
      autoSend: true,
      startDate: '2027-01-05',
      bodyTemplate: 'Hi {{donorName}}, your {{year}} letter: {{loginUrl}}',
      bodyTemplatesByLocale: {},
    });
  });

  it('collects per-locale templates from their configured columns', async () => {
    const client = makeClient({
      data: {
        boards: [
          {
            items_page: {
              items: [
                {
                  id: '11',
                  name: 'Letter emails',
                  column_values: [
                    { id: 'checkbox_1', text: 'v', checked: true },
                    { id: 'date_2', text: '2027-01-05' },
                    { id: 'long_text_1', text: 'Default {{donorName}}' },
                    { id: 'long_text_es', text: 'Hola {{donorName}}' },
                    { id: 'long_text_zht', text: null },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    const settings = await client.getLetterSettings({ boardId: 456, columns: letterCronColumns, settingsItemName: 'Letter emails' });
    // An empty locale column is omitted from the map, so callers fall through to the default.
    expect(settings?.bodyTemplatesByLocale).toEqual({ es: 'Hola {{donorName}}' });
  });

  it('reports autoSend false when the checkbox is unchecked and blanks for empty columns', async () => {
    const client = makeClient({
      data: {
        boards: [
          {
            items_page: {
              items: [
                {
                  id: '11',
                  name: 'Letter emails',
                  column_values: [
                    { id: 'checkbox_1', text: null, checked: false },
                    { id: 'date_2', text: null },
                    { id: 'long_text_1', text: null },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    expect(await client.getLetterSettings({ boardId: 456, columns: letterCronColumns, settingsItemName: 'Letter emails' })).toEqual({
      autoSend: false,
      startDate: '',
      bodyTemplate: '',
      bodyTemplatesByLocale: {},
    });
  });

  it('returns null when the settings board has no items', async () => {
    const client = makeClient({ data: { boards: [{ items_page: { items: [] } }] } });
    expect(await client.getLetterSettings({ boardId: 456, columns: letterCronColumns, settingsItemName: 'Letter emails' })).toBeNull();
  });

  it('prefers the item named "Letter emails" over stray board-template defaults like "Task 1"', async () => {
    const client = makeClient({
      data: {
        boards: [
          {
            items_page: {
              items: [
                {
                  id: '10',
                  name: 'Task 1',
                  column_values: [
                    { id: 'checkbox_1', text: null, checked: false },
                    { id: 'date_2', text: null },
                    { id: 'long_text_1', text: null },
                  ],
                },
                {
                  id: '11',
                  name: 'Letter emails',
                  column_values: [
                    { id: 'checkbox_1', text: 'v', checked: true },
                    { id: 'date_2', text: '2027-01-05' },
                    { id: 'long_text_1', text: 'Hi {{donorName}}' },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    expect(await client.getLetterSettings({ boardId: 456, columns: letterCronColumns, settingsItemName: 'Letter emails' })).toEqual({
      autoSend: true,
      startDate: '2027-01-05',
      bodyTemplate: 'Hi {{donorName}}',
      bodyTemplatesByLocale: {},
    });
  });

  it('throws (never reads an arbitrary item) when no item matches the configured settings name', async () => {
    // A renamed settings item or a hand-recreated board must fail loudly: silently reading
    // autoSend/startDate/templates off whatever item happens to be first could arm (or disarm)
    // the automated letter run from a stray "Task 1".
    const client = makeClient({
      data: {
        boards: [
          {
            items_page: {
              items: [
                {
                  id: '10',
                  name: 'Task 1',
                  column_values: [
                    { id: 'checkbox_1', text: 'v', checked: true },
                    { id: 'date_2', text: '2027-01-05' },
                    { id: 'long_text_1', text: 'stray template' },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    await expect(
      client.getLetterSettings({ boardId: 456, columns: letterCronColumns, settingsItemName: 'Letter emails' })
    ).rejects.toThrow(/no item named "Letter emails"/);
  });

  it('matches the settings item by the configured name, not a hardcoded literal', async () => {
    const client = makeClient({
      data: {
        boards: [
          {
            items_page: {
              items: [
                {
                  id: '11',
                  name: 'Custom settings item',
                  column_values: [
                    { id: 'checkbox_1', text: 'v', checked: true },
                    { id: 'date_2', text: '2027-01-05' },
                    { id: 'long_text_1', text: 'Hi {{donorName}}' },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    const settings = await client.getLetterSettings({
      boardId: 456,
      columns: letterCronColumns,
      settingsItemName: 'Custom settings item',
    });
    expect(settings?.autoSend).toBe(true);
  });
});

describe('HttpMondayClient.listYearActivity (personIds)', () => {
  it('collects unique donor ids from the year’s donations across pages', async () => {
    const pages = [
      {
        data: {
          boards: [
            {
              items_page: {
                cursor: 'page2',
                items: [
                  {
                    id: '1',
                    column_values: [
                      { id: 'date_col', text: '2026-03-01' },
                      { id: 'donation_status_col', text: 'Received' },
                      { id: 'link_col', text: 'Jane', linked_item_ids: ['77'], linked_items: [{ id: '77', board: { id: '999' } }] },
                    ],
                  },
                  {
                    id: '2',
                    column_values: [
                      { id: 'date_col', text: '2026-11-12' },
                      { id: 'donation_status_col', text: 'Received' },
                      { id: 'link_col', text: 'Jane', linked_item_ids: ['77'], linked_items: [{ id: '77', board: { id: '999' } }] },
                    ],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        data: {
          next_items_page: {
            cursor: null,
            items: [
              {
                id: '3',
                column_values: [
                  { id: 'date_col', text: '2026-06-30' },
                  { id: 'donation_status_col', text: 'Received' },
                  { id: 'link_col', text: 'Sam', linked_item_ids: ['88'], linked_items: [{ id: '88', board: { id: '999' } }] },
                ],
              },
            ],
          },
        },
      },
    ];
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => pages[call++],
    }));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

    expect((await client.listYearActivity(2026, [])).personIds).toEqual(['77', '88']);
  });

  it('skips gifts dated before historyStartISO so a mid-year floor never earns a letter for the earlier part', async () => {
    const sweepItem = (id: string, date: string, donorId: string) => ({
      id,
      column_values: [
        { id: 'date_col', text: date },
        { id: 'donation_status_col', text: 'Received' },
        { id: 'link_col', text: 'x', linked_item_ids: [donorId], linked_items: [{ id: donorId, board: { id: '999' } }] },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { boards: [{ items_page: { cursor: null, items: [sweepItem('1', '2026-02-01', '77'), sweepItem('2', '2026-09-01', '88')] } }] },
      }),
    });
    const flooredCfg = { countableStatuses, historyStartISO: '2026-06-01' };
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, flooredCfg, null, null, fetchMock);

    expect((await client.listYearActivity(2026, [])).personIds).toEqual(['88']);
  });

  it('skips gifts of an excluded Gift Type, so they never earn a letter on their own', async () => {
    const sweepItem = (id: string, giftType: string, donorId: string) => ({
      id,
      column_values: [
        { id: 'date_col', text: '2026-03-01' },
        { id: 'desc_col', text: giftType },
        { id: 'donation_status_col', text: 'Received' },
        { id: 'link_col', text: 'x', linked_item_ids: [donorId], linked_items: [{ id: donorId, board: { id: '999' } }] },
      ],
    });
    let query = '';
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      query = (JSON.parse(init.body as string) as { query: string }).query;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            boards: [
              {
                items_page: {
                  cursor: null,
                  items: [
                    sweepItem('1', 'Event Ticket', '77'),
                    sweepItem('2', 'Donor Advised Fund', '88'),
                    sweepItem('3', 'event ticket', '99'),
                    sweepItem('4', 'Donation', '99'),
                  ],
                },
              },
            ],
          },
        }),
      };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

    expect((await client.listYearActivity(2026, ['Event Ticket'])).personIds).toEqual(['88', '99']);
    expect(query).toContain('desc_col');
  });

  it('ends the sweep gracefully when next_items_page comes back null (expired cursor)', async () => {
    // Same guard as fetchItemsLinkedToDonor: an expired/invalid cursor yields a null
    // next_items_page, which must terminate the loop with the ids gathered so far rather than
    // throw mid-sweep and cost the January cron a whole day's run.
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
                      id: '1',
                      column_values: [
                        { id: 'date_col', text: '2026-03-01' },
                        { id: 'donation_status_col', text: 'Received' },
                        { id: 'link_col', text: 'Jane', linked_item_ids: ['77'], linked_items: [{ id: '77', board: { id: '999' } }] },
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

    expect((await client.listYearActivity(2026, [])).personIds).toEqual(['77']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('drops donations whose date falls outside the requested year (server filter is advisory)', async () => {
    const client = makeClient({
      data: {
        boards: [
          {
            items_page: {
              cursor: null,
              items: [
                {
                  id: '1',
                  column_values: [
                    { id: 'date_col', text: '2025-12-31' },
                    { id: 'donation_status_col', text: 'Received' },
                    { id: 'link_col', text: 'Old', linked_item_ids: ['66'], linked_items: [{ id: '66', board: { id: '999' } }] },
                  ],
                },
                {
                  id: '2',
                  column_values: [
                    { id: 'date_col', text: '2026-01-01' },
                    { id: 'donation_status_col', text: 'Received' },
                    { id: 'link_col', text: 'Jane', linked_item_ids: ['77'], linked_items: [{ id: '77', board: { id: '999' } }] },
                  ],
                },
              ],
            },
          },
        ],
      },
    });

    expect((await client.listYearActivity(2026, [])).personIds).toEqual(['77']);
  });

  it('skips donations with non-countable statuses so donors with only Failed/Pending gifts get no letter', async () => {
    const item = (id: string, status: string, donorId: string) => ({
      id,
      column_values: [
        { id: 'date_col', text: '2026-04-01' },
        { id: 'donation_status_col', text: status },
        { id: 'link_col', text: 'Donor', linked_item_ids: [donorId], linked_items: [{ id: donorId, board: { id: '999' } }] },
      ],
    });
    const client = makeClient({
      data: {
        boards: [
          {
            items_page: {
              cursor: null,
              items: [
                item('1', 'Failed', '66'), // donor 66's only gift failed — no letter
                item('2', 'Received', '77'),
                item('3', 'Pending', '88'), // pending is not a completed gift
                item('4', 'Received (Historical)', '99'), // migrated gifts are real gifts
              ],
            },
          },
        ],
      },
    });

    expect((await client.listYearActivity(2026, [])).personIds).toEqual(['77', '99']);
  });

  it('requests the donation status column in the sweep query', async () => {
    let captured: { query: string } | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } }),
      };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

    await client.listYearActivity(2026, []);

    expect(captured!.query).toContain('donation_status_col');
  });

  it('sends the year bounds as variables, not interpolated into the query', async () => {
    let captured: { query: string; variables: Record<string, unknown> } | null = null;
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { boards: [{ items_page: { cursor: null, items: [] } }] } }),
      };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, donationsCfg, null, null, fetchMock);

    await client.listYearActivity(2026, []);

    expect(captured).not.toBeNull();
    expect(captured!.variables.from).toBe('2026-01-01');
    expect(captured!.variables.to).toBe('2026-12-31');
    expect(captured!.query).toContain('between');
  });
});

describe('HttpMondayClient DTD match lines', () => {
  const matchColumns: MondayColumns = {
    ...columns,
    donationMatchesGift: 'matches_col',
    donationMatchStatus: 'match_status_col',
    donationMatchedBy: 'matched_by_col',
    donorDtdLink: 'dtd_col',
  };
  const dtdValue = (url: string) => ({ id: 'dtd_col', text: `Match - ${url}`, value: JSON.stringify({ url, text: 'Match' }) });
  const donorResponse = (dtd?: ReturnType<typeof dtdValue>) => ({
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
              ...(dtd ? [dtd] : []),
            ],
          },
        ],
      },
    }),
  });
  const gift = (id: string, date: string, amount: string, extra: Record<string, unknown>[] = [], status = 'Received') => ({
    id,
    column_values: [
      { id: 'amount_col', text: amount },
      { id: 'date_col', text: date },
      { id: 'desc_col', text: 'gift' },
      { id: 'donation_status_col', text: status },
      ...extra,
    ],
  });
  const matchRow = (id: string, date: string, amount: string, giftId: string, company: string, status = 'Received') =>
    gift(id, date, amount, [
      { id: 'matches_col', text: 'orig', linked_item_ids: [giftId] },
      { id: 'matched_by_col', text: company, linked_items: [{ name: company }] },
    ], status);
  const page = (items: unknown[]) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { boards: [{ items_page: { cursor: null, items } }] } }),
  });
  function clientFor(cols: MondayColumns, items: unknown[], dtd?: ReturnType<typeof dtdValue>) {
    const fetchMock = vi.fn().mockResolvedValueOnce(donorResponse(dtd)).mockResolvedValueOnce(page(items));
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', cols, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
    return { client, fetchMock };
  }

  it('attaches a paired match to its original gift', async () => {
    const { client } = clientFor(matchColumns, [
      gift('g-1', '2026-03-01', '100'),
      matchRow('m-1', '2026-04-01', '100', 'g-1', 'Acme Corp'),
    ]);
    const data = await client.getMemberPortalData('donor-1');
    const original = data.donations.find((d) => d.amount === '100' && d.date === '2026-03-01');
    expect(original?.match).toEqual({ date: '2026-04-01', amount: '100', company: 'Acme Corp' });
    expect(original?.matchHintUrl ?? null).toBeNull();
  });

  it('shows the latest match when two point at one gift', async () => {
    const { client } = clientFor(matchColumns, [
      gift('g-1', '2026-03-01', '100'),
      matchRow('m-1', '2026-04-01', '50', 'g-1', 'Early Co'),
      matchRow('m-2', '2026-05-01', '60', 'g-1', 'Late Co'),
    ]);
    const data = await client.getMemberPortalData('donor-1');
    expect(data.donations[0]!.match).toEqual({ date: '2026-05-01', amount: '60', company: 'Late Co' });
  });

  it('ignores a match pointing at a gift that is not in the donor list', async () => {
    const { client } = clientFor(matchColumns, [matchRow('m-1', '2026-04-01', '100', 'g-elsewhere', 'Acme Corp')]);
    const data = await client.getMemberPortalData('donor-1');
    expect(data.donations).toHaveLength(1);
    expect(data.donations[0]!.match ?? null).toBeNull();
  });

  it('match rows still listed and counted', async () => {
    // A history floor makes totalDonated the sum of kept rows, so the match row must be counted.
    const fetchMock = vi.fn().mockResolvedValueOnce(donorResponse()).mockResolvedValueOnce(page([
      gift('g-1', '2026-03-01', '100'),
      matchRow('m-1', '2026-04-01', '100', 'g-1', 'Acme Corp'),
    ]));
    const floored = new HttpMondayClient('https://api.monday.com/v2', 'token', matchColumns, 999, 1, 2, { countableStatuses, historyStartISO: '2026-01-01' }, pledgesCfg, 3, fetchMock);
    const data = await floored.getMemberPortalData('donor-1');
    expect(data.donations.map((d) => d.amount)).toEqual(['100', '100']);
    expect(data.totalDonated).toBe('200');
  });

  it('gives a waiting gift the donor DTD link, https only', async () => {
    const { client } = clientFor(
      matchColumns,
      [
        gift('g-1', '2026-03-01', '100', [{ id: 'match_status_col', text: 'Waiting for donor' }]),
        gift('g-2', '2026-03-02', '20', [{ id: 'match_status_col', text: 'Waiting for donor (maybe)' }]),
        gift('g-3', '2026-03-03', '30'),
      ],
      dtdValue('https://dtd.example/abc')
    );
    const data = await client.getMemberPortalData('donor-1');
    expect(data.donations.map((d) => d.matchHintUrl ?? null)).toEqual(['https://dtd.example/abc', null, null]);
  });

  it('drops a non-https DTD link', async () => {
    const { client } = clientFor(
      matchColumns,
      [gift('g-1', '2026-03-01', '100', [{ id: 'match_status_col', text: 'Waiting for donor' }])],
      dtdValue('javascript:alert(1)')
    );
    const data = await client.getMemberPortalData('donor-1');
    expect(data.donations[0]!.matchHintUrl ?? null).toBeNull();
  });

  it('feature off when any new column is a placeholder', async () => {
    const off = { ...matchColumns, donorDtdLink: 'REPLACE_WITH_COLUMN_ID' };
    const { client, fetchMock } = clientFor(off, [
      gift('g-1', '2026-03-01', '100', [{ id: 'match_status_col', text: 'Waiting for donor' }]),
      matchRow('m-1', '2026-04-01', '100', 'g-1', 'Acme Corp'),
    ]);
    const data = await client.getMemberPortalData('donor-1');
    expect(data.donations).toHaveLength(2);
    expect(data.donations.every((d) => (d.match ?? null) === null && (d.matchHintUrl ?? null) === null)).toBe(true);
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).body as string).not.toContain('REPLACE_WITH_COLUMN_ID');
      expect((call[1] as RequestInit).body as string).not.toContain('matches_col');
    }
  });

  it('requests the match columns and linked item names when enabled', async () => {
    const { client, fetchMock } = clientFor(matchColumns, []);
    await client.getMemberPortalData('donor-1');
    const donations = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).query as string;
    expect(donations).toContain('matches_col');
    expect(donations).toContain('match_status_col');
    expect(donations).toContain('matched_by_col');
    expect(donations).toContain('linked_items');
  });
});

const employerCfg = {
  affiliationsBoardId: 555,
  affiliationColumns: { personLink: 'aff_person', organizationLink: 'aff_org', status: 'aff_status', primary: 'aff_primary' },
  currentStatusLabel: 'Current',
  personAffiliationsLink: 'people_affs',
};

type Captured = { query: string; variables: Record<string, unknown> };

// Answers each request in turn from `responses`, recording every body.
function sequencedClient(responses: unknown[], bodies: Captured[] = [], cols: MondayColumns = columns) {
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string) as Captured);
    const body = responses[bodies.length - 1];
    return { ok: true, status: 200, json: async () => body };
  });
  return { client: new HttpMondayClient('https://api.monday.com/v2', 'token', cols, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock), fetchMock };
}

describe('HttpMondayClient.findOrganizationsByNames', () => {
  it('looks every name up in one exact-name query, as variables', async () => {
    const bodies: Captured[] = [];
    const { client } = sequencedClient([{ data: { items_page_by_column_values: { items: [{ id: '7', name: 'Google, LLC' }] } } }], bodies);

    const found = await client.findOrganizationsByNames({ boardId: 3, names: ['Google', 'Google, LLC'] });

    expect(found).toEqual([{ id: '7', name: 'Google, LLC' }]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.query).toContain('items_page_by_column_values');
    expect(bodies[0]!.query).not.toContain('Google');
    expect(bodies[0]!.variables).toEqual({ boardId: 3, columns: [{ column_id: 'name', column_values: ['Google', 'Google, LLC'] }] });
  });

  it('makes no request for no names', async () => {
    const { client, fetchMock } = sequencedClient([]);
    expect(await client.findOrganizationsByNames({ boardId: 3, names: [] })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HttpMondayClient.getPersonAffiliations', () => {
  it("reads the person's linked affiliations, then each one's Organization, Status and Primary", async () => {
    const bodies: Captured[] = [];
    const { client } = sequencedClient(
      [
        { data: { items: [{ id: '10', name: 'Jane', state: 'active', column_values: [{ id: 'people_affs', text: '', linked_item_ids: ['21', '22'] }] }] } },
        {
          data: {
            items: [
              {
                id: '21',
                name: 'Jane — Acme',
                state: 'active',
                column_values: [
                  { id: 'aff_org', text: 'Acme', linked_item_ids: ['501'], linked_items: [{ name: 'Acme' }] },
                  { id: 'aff_status', text: 'Current' },
                  { id: 'aff_primary', text: 'v' },
                ],
              },
              {
                id: '22',
                name: 'Jane — ?',
                state: 'active',
                column_values: [
                  { id: 'aff_org', text: '', linked_item_ids: [], linked_items: [] },
                  { id: 'aff_status', text: '' },
                  { id: 'aff_primary', text: '' },
                ],
              },
            ],
          },
        },
      ],
      bodies,
    );

    const affiliations = await client.getPersonAffiliations({ donorItemId: '10', employer: employerCfg });

    expect(affiliations).toEqual([
      { id: '21', organizationId: '501', organizationName: 'Acme', statusLabel: 'Current', primary: true, portalAccess: false },
      { id: '22', organizationId: null, organizationName: null, statusLabel: null, primary: false, portalAccess: false },
    ]);
    expect(bodies[0]!.variables).toEqual({ itemId: 10 });
    expect(bodies[0]!.query).toContain('people_affs');
    expect(bodies[1]!.variables).toEqual({ itemIds: [21, 22] });
  });

  it('drops archived and deleted affiliations, and asks for state', async () => {
    const bodies: Captured[] = [];
    const affItem = (id: string, state: string) => ({
      id,
      name: id,
      state,
      column_values: [
        { id: 'aff_org', text: 'Google', linked_item_ids: ['501'], linked_items: [{ name: 'Google' }] },
        { id: 'aff_status', text: 'Current' },
        { id: 'aff_primary', text: 'v' },
      ],
    });
    const { client } = sequencedClient(
      [
        { data: { items: [{ id: '10', name: 'Jane', state: 'active', column_values: [{ id: 'people_affs', text: '', linked_item_ids: ['21', '22', '23'] }] }] } },
        { data: { items: [affItem('21', 'active'), affItem('22', 'archived'), affItem('23', 'deleted')] } },
      ],
      bodies,
    );

    const affiliations = await client.getPersonAffiliations({ donorItemId: '10', employer: employerCfg });

    expect(affiliations.map((a) => a.id)).toEqual(['21']);
    expect(bodies[1]!.query).toMatch(/\bstate\b/);
  });

  it('treats an archived person as not found', async () => {
    const { client } = sequencedClient([{ data: { items: [{ id: '10', name: 'Jane', state: 'archived', column_values: [] }] } }]);
    await expect(client.getPersonAffiliations({ donorItemId: '10', employer: employerCfg })).rejects.toThrow('not found');
  });

  it('makes one request when the person has no affiliations', async () => {
    const { client, fetchMock } = sequencedClient([
      { data: { items: [{ id: '10', name: 'Jane', state: 'active', column_values: [{ id: 'people_affs', text: '', linked_item_ids: [] }] }] } },
    ]);
    expect(await client.getPersonAffiliations({ donorItemId: '10', employer: employerCfg })).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('HttpMondayClient affiliation writes', () => {
  it('createAffiliation links person and Organization, Current and Primary, as variables', async () => {
    const bodies: Captured[] = [];
    const { client } = sequencedClient([{ data: { create_item: { id: '30' } } }], bodies);

    await client.createAffiliation({ employer: employerCfg, itemName: 'Jane — Google', donorItemId: '10', organizationItemId: '501' });

    expect(bodies[0]!.query).toContain('create_item');
    expect(bodies[0]!.query).not.toContain('Jane');
    expect(bodies[0]!.variables.boardId).toBe(555);
    expect(bodies[0]!.variables.itemName).toBe('Jane — Google');
    expect(JSON.parse(bodies[0]!.variables.columnValues as string)).toEqual({
      aff_person: { item_ids: [10] },
      aff_org: { item_ids: [501] },
      aff_status: { label: 'Current' },
      aff_primary: { checked: 'true' },
    });
  });

  it('updateAffiliation makes an affiliation Current and Primary', async () => {
    const bodies: Captured[] = [];
    const { client } = sequencedClient([{ data: { change_multiple_column_values: { id: '21' } } }], bodies);

    await client.updateAffiliation({ employer: employerCfg, itemId: '21', makeCurrent: true, primary: true });

    expect(bodies[0]!.query).toContain('change_multiple_column_values');
    expect(bodies[0]!.variables.boardId).toBe(555);
    expect(bodies[0]!.variables.itemId).toBe(21);
    expect(JSON.parse(bodies[0]!.variables.columnValues as string)).toEqual({ aff_status: { label: 'Current' }, aff_primary: { checked: 'true' } });
  });

  it('updateAffiliation clearing Primary sends only the checkbox, as null', async () => {
    const bodies: Captured[] = [];
    const { client } = sequencedClient([{ data: { change_multiple_column_values: { id: '22' } } }], bodies);

    await client.updateAffiliation({ employer: employerCfg, itemId: '22', makeCurrent: false, primary: false });

    expect(JSON.parse(bodies[0]!.variables.columnValues as string)).toEqual({ aff_primary: null });
  });
});

describe('HttpMondayClient.getDonorContactInfo employer', () => {
  const donorItem = { id: 'd', name: 'Jane', column_values: [{ id: 'employer_col', text: 'Google, LLC' }] };

  it('reads People → Employer Name', async () => {
    const bodies: Captured[] = [];
    const { client } = sequencedClient([{ data: { items: [donorItem] } }], bodies);
    expect((await client.getDonorContactInfo('d')).employer).toBe('Google, LLC');
    expect(bodies[0]!.query).toContain('employer_col');
  });

  it("is '' and not queried while the column is the placeholder", async () => {
    const bodies: Captured[] = [];
    const { client } = sequencedClient([{ data: { items: [donorItem] } }], bodies, { ...columns, donorEmployer: 'REPLACE_WITH_COLUMN_ID' });
    expect((await client.getDonorContactInfo('d')).employer).toBe('');
    expect(bodies[0]!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
  });
});

describe('HttpMondayClient.getDonorEmails', () => {
  function capturing(items: unknown[], cols: MondayColumns = columns) {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return { ok: true, status: 200, json: async () => ({ data: { items } }) };
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', cols, 999, 1, 2, donationsCfg, pledgesCfg, 3, fetchMock);
    return { client, calls };
  }

  it('reads both addresses (from the email value, not its label) and both consent labels', async () => {
    const { client, calls } = capturing([
      {
        id: 'donor-1',
        name: 'Jordan',
        column_values: [
          { id: 'email_col', text: 'Jordan (work)', value: JSON.stringify({ email: 'jordan@example.org', text: 'Jordan (work)' }) },
          { id: 'household_col', text: 'family@example.org', value: JSON.stringify({ email: 'family@example.org', text: 'family@example.org' }) },
          { id: 'email_consent_col', text: 'Subscribed', value: null },
          { id: 'household_consent_col', text: 'Cleaned', value: null },
        ],
      },
    ]);

    expect(await client.getDonorEmails('donor-1')).toEqual({
      personal: 'jordan@example.org',
      household: 'family@example.org',
      personalConsent: 'Subscribed',
      householdConsent: 'Cleaned',
    });
    expect(calls[0]!.variables).toEqual({ itemId: 'donor-1' });
    expect(calls[0]!.query).toContain('column_values(ids: ["email_col","household_col","email_consent_col","household_consent_col"])');
  });

  it('leaves gated columns out of the query and reads them as blank', async () => {
    const gated: MondayColumns = {
      ...columns,
      donorHouseholdEmail: 'REPLACE_WITH_COLUMN_ID',
      donorEmailConsent: 'REPLACE_WITH_COLUMN_ID',
      donorHouseholdEmailConsent: 'REPLACE_WITH_COLUMN_ID',
    };
    const { client, calls } = capturing([{ id: 'donor-1', name: 'Jane', column_values: [emailValue('jane@example.org')] }], gated);

    expect(await client.getDonorEmails('donor-1')).toEqual({ personal: 'jane@example.org', household: '', personalConsent: '', householdConsent: '' });
    expect(calls[0]!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
    expect(calls[0]!.query).toContain('column_values(ids: ["email_col"])');
  });

  it('throws when the donor item does not exist', async () => {
    const { client } = capturing([]);
    await expect(client.getDonorEmails('missing')).rejects.toThrow('not found');
  });
});

// ---- Organization reps: Affiliations and organization reads (Task 3) ----

const orgReadCfg = {
  organizations: {
    portalAccessColumn: 'portal_col',
    workEmailColumn: 'work_email_col',
    addressColumns: ['street_col', 'city_col', 'zip_col'],
    acknowledgmentSignedOff: false,
    volunteerFloor: 3,
  },
  employer: {
    affiliationsBoardId: 555,
    affiliationColumns: { personLink: 'aff_person', organizationLink: 'aff_org', status: 'aff_status', primary: 'aff_primary' },
    currentStatusLabel: 'Current',
    personAffiliationsLink: 'people_aff',
  },
  volunteerCompletedStatuses: ['Completed'],
};

// Every request's body is recorded; responses come back in order (the last repeats).
function orgClient(
  bodies: unknown[],
  overrides: { columns?: Partial<MondayColumns>; orgs?: typeof orgReadCfg; donationsCfg?: { countableStatuses: string[]; historyStartISO: string | null } } = {},
) {
  const sent: { query: string; variables: Record<string, unknown> }[] = [];
  let i = 0;
  const fetchMock = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(init.body as string) as { query: string; variables: Record<string, unknown> });
    const body = bodies[Math.min(i++, bodies.length - 1)];
    return { ok: true, status: 200, json: async () => body };
  });
  const client = new HttpMondayClient(
    'https://api.monday.com/v2',
    'token',
    { ...columns, ...overrides.columns },
    999,
    1,
    2,
    overrides.donationsCfg ?? donationsCfg,
    null,
    3,
    fetchMock,
    overrides.orgs ?? orgReadCfg,
  );
  return { client, sent, fetchMock };
}

const page = (items: unknown[], cursor: string | null = null) => ({ data: { boards: [{ items_page: { cursor, items } }] } });

describe('findDonorsByEmail matchedPersonal', () => {
  it('is true only when the Personal Email, not the Household Email, equals the address', async () => {
    const hh = (address: string) => ({ id: 'household_col', text: address, value: JSON.stringify({ email: address, text: address }) });
    const { client } = orgClient([
      page([
        { id: '1', name: 'Personal', column_values: [emailValue('a@example.org'), hh('other@example.org')] },
        { id: '2', name: 'Household', column_values: [emailValue('other@example.org'), hh('a@example.org')] },
      ]),
    ]);

    const matches = await client.findDonorsByEmail('a@example.org');

    expect(matches.map((m) => [m.id, m.matchedPersonal])).toEqual([['1', true], ['2', false]]);
  });
});

function affItem(id: string, over: { work?: string; state?: string; person?: string; org?: string; status?: string; portal?: boolean } = {}) {
  return {
    id,
    name: `Aff ${id}`,
    state: over.state ?? 'active',
    column_values: [
      { id: 'aff_person', text: 'P', linked_item_ids: over.person === undefined ? ['p1'] : [over.person] },
      { id: 'aff_org', text: 'O', linked_item_ids: over.org === undefined ? ['o1'] : [over.org] },
      { id: 'aff_status', text: over.status ?? 'Current' },
      { id: 'portal_col', text: over.portal ? 'v' : '' },
      { id: 'work_email_col', text: over.work ?? '', value: JSON.stringify({ email: over.work ?? '', text: over.work ?? '' }) },
    ],
  };
}

describe('HttpMondayClient.findAffiliationsByWorkEmail', () => {
  it('keeps only affiliations whose Work Email equals the address after trim and lowercase', async () => {
    const { client, sent } = orgClient([
      page([affItem('1', { work: ' Rep@Acme.org ', portal: true }), affItem('2', { work: 'someone-else@acme.org' })]),
    ]);

    const result = await client.findAffiliationsByWorkEmail('rep@acme.org');

    expect(result).toEqual([
      { id: '1', personItemId: 'p1', organizationId: 'o1', statusLabel: 'Current', portalAccess: true, workEmail: ' Rep@Acme.org ' },
    ]);
    expect(sent[0]!.variables.boardId).toBe(555);
    expect(sent[0]!.query).toContain('work_email_col');
  });

  it('returns [] without a Monday call when the Work Email column is the placeholder', async () => {
    const orgs = { ...orgReadCfg, organizations: { ...orgReadCfg.organizations, workEmailColumn: 'REPLACE_WITH_COLUMN_ID' } };
    const { client, fetchMock } = orgClient([page([])], { orgs });
    expect(await client.findAffiliationsByWorkEmail('rep@acme.org')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HttpMondayClient.getAffiliation', () => {
  // items(ids:) answers for any board, so the read asks for the item's board.
  const onBoard = (item: ReturnType<typeof affItem>, boardId: string | number = 555) => ({ ...item, board: { id: String(boardId) } });

  it('returns the affiliation when active on the Affiliations board', async () => {
    const { client, sent } = orgClient([{ data: { items: [onBoard(affItem('7', { work: 'r@acme.org', status: 'Former' }))] } }]);
    const aff = await client.getAffiliation('7');
    expect(aff).toMatchObject({ id: '7', statusLabel: 'Former', workEmail: 'r@acme.org', portalAccess: false });
    expect(sent[0]!.query).toContain('board { id }');
  });

  it('returns null for an item on another board', async () => {
    const { client } = orgClient([{ data: { items: [onBoard(affItem('7', { portal: true }), 999)] } }]);
    expect(await client.getAffiliation('7')).toBeNull();
  });

  it('returns null for an item without a board', async () => {
    const { client } = orgClient([{ data: { items: [affItem('7', { portal: true })] } }]);
    expect(await client.getAffiliation('7')).toBeNull();
  });

  it('returns null for an archived item', async () => {
    const { client } = orgClient([{ data: { items: [onBoard(affItem('7', { state: 'archived' }))] } }]);
    expect(await client.getAffiliation('7')).toBeNull();
  });

  it('returns null for a missing item', async () => {
    const { client } = orgClient([{ data: { items: [] } }]);
    expect(await client.getAffiliation('7')).toBeNull();
  });
});

describe('HttpMondayClient.getOrganizationAffiliations', () => {
  it('reads the Affiliations board filtered on the Organization link', async () => {
    const { client, sent } = orgClient([page([affItem('1', { portal: true }), affItem('2', { state: 'archived' })])]);
    const result = await client.getOrganizationAffiliations('501');
    expect(result.map((a) => a.id)).toEqual(['1']);
    expect(sent[0]!.query).toContain('aff_org');
    expect(sent[0]!.variables).toMatchObject({ boardId: 555, donorItemId: 501 });
  });
});

describe('HttpMondayClient.getOrganization', () => {
  const orgItem = (over: Record<string, unknown> = {}) => ({
    id: 'o1',
    name: 'Acme',
    state: 'active',
    board: { id: '2' },
    column_values: [
      { id: 'street_col', text: '123 Main St' },
      { id: 'city_col', text: 'San Jose' },
      { id: 'zip_col', text: '95113' },
    ],
    ...over,
  });

  it('returns the name and the address columns joined', async () => {
    const { client } = orgClient([{ data: { items: [orgItem()] } }]);
    expect(await client.getOrganization('o1')).toEqual({ id: 'o1', name: 'Acme', address: '123 Main St, San Jose, 95113' });
  });

  it('skips empty address parts', async () => {
    const { client } = orgClient([
      { data: { items: [orgItem({ column_values: [{ id: 'street_col', text: '' }, { id: 'city_col', text: 'San Jose' }, { id: 'zip_col', text: '' }] })] } },
    ]);
    expect((await client.getOrganization('o1'))!.address).toBe('San Jose');
  });

  it('returns null for an item on the People board', async () => {
    const { client } = orgClient([{ data: { items: [orgItem({ board: { id: '999' } })] } }]);
    expect(await client.getOrganization('o1')).toBeNull();
  });

  it('returns null for an archived organization', async () => {
    const { client } = orgClient([{ data: { items: [orgItem({ state: 'archived' })] } }]);
    expect(await client.getOrganization('o1')).toBeNull();
  });

  it('returns address "" and requests no address columns when the list is empty', async () => {
    const orgs = { ...orgReadCfg, organizations: { ...orgReadCfg.organizations, addressColumns: [] } };
    const { client, sent } = orgClient([{ data: { items: [orgItem({ column_values: [] })] } }], { orgs });
    expect((await client.getOrganization('o1'))!.address).toBe('');
    expect(sent[0]!.query).not.toContain('street_col');
  });

  it('returns address "" and never names the placeholder when any address column is the placeholder', async () => {
    const orgs = { ...orgReadCfg, organizations: { ...orgReadCfg.organizations, addressColumns: ['street_col', 'REPLACE_WITH_COLUMN_ID'] } };
    const { client, sent } = orgClient([{ data: { items: [orgItem({ column_values: [] })] } }], { orgs });
    expect((await client.getOrganization('o1'))!.address).toBe('');
    expect(sent[0]!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
    expect(sent[0]!.query).not.toContain('street_col');
  });
});

describe('HttpMondayClient organization gifts and matches', () => {
  const giftItem = (id: string, status: string, date: string, giftType = 'Sponsorship') => ({
    id,
    name: `Gift ${id}`,
    column_values: [
      { id: 'amount_col', text: '$500.00' },
      { id: 'date_col', text: date },
      { id: 'desc_col', text: giftType },
      { id: 'donation_status_col', text: status },
    ],
  });

  it('getOrganizationGifts keeps countable statuses on or after the history floor', async () => {
    const floored = { countableStatuses, historyStartISO: '2026-01-01' };
    const { client, sent } = orgClient(
      [page([giftItem('1', 'Received', '2026-03-01'), giftItem('2', 'Failed', '2026-03-02'), giftItem('3', 'Received', '2025-12-31')])],
      { donationsCfg: floored },
    );
    const gifts = await client.getOrganizationGifts('501');
    expect(gifts).toEqual([{ itemId: '1', date: '2026-03-01', amount: '$500.00', giftType: 'Sponsorship' }]);
    expect(sent[0]!.query).toContain('link_col');
    expect(sent[0]!.variables).toMatchObject({ boardId: 1, donorItemId: 501 });
  });

  it('getOrganizationMatches filters on the Matched By column', async () => {
    const { client, sent } = orgClient([page([giftItem('1', 'Received', '2026-03-01', 'Matching Donation')])], {
      columns: { donationMatchedBy: 'matched_by_col' },
    });
    const matches = await client.getOrganizationMatches('o1');
    expect(matches.map((m) => m.itemId)).toEqual(['1']);
    expect(sent[0]!.query).toContain('column_id: "matched_by_col"');
  });

  it('getOrganizationMatches returns [] with no Monday call when Matched By is the placeholder', async () => {
    const { client, fetchMock } = orgClient([page([])]);
    expect(await client.getOrganizationMatches('o1')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('HttpMondayClient.listYearActivity', () => {
  const linkedItem = (id: string, giftType: string, link: { id: string; board: string }[], matchedBy: string[] = []) => ({
    id,
    column_values: [
      { id: 'date_col', text: '2026-03-01' },
      { id: 'donation_status_col', text: 'Received' },
      { id: 'desc_col', text: giftType },
      {
        id: 'link_col',
        text: 'x',
        linked_item_ids: link.map((l) => l.id),
        linked_items: link.map((l) => ({ id: l.id, board: { id: l.board } })),
      },
      { id: 'matched_by_col', text: 'm', linked_item_ids: matchedBy },
    ],
  });

  it('splits Donor links by board and keeps excluded gift types out of personIds only', async () => {
    const { client, sent } = orgClient(
      [
        page([
          linkedItem('1', 'Donation', [{ id: '77', board: '999' }]),
          linkedItem('2', 'Sponsorship', [{ id: '501', board: '2' }]),
          linkedItem('3', 'Sponsorship', [{ id: '88', board: '999' }]),
          linkedItem('4', 'Matching Donation', [{ id: '77', board: '999' }], ['502']),
          linkedItem('5', 'Donation', [{ id: '503', board: '2' }]),
        ]),
      ],
      { columns: { donationMatchedBy: 'matched_by_col' } },
    );

    const result = await client.listYearActivity(2026, ['Sponsorship']);

    expect(result.personIds.sort()).toEqual(['77']);
    expect(result.organizationIds.sort()).toEqual(['501', '502', '503']);
    expect(sent[0]!.query).toContain('board { id }');
    expect(sent[0]!.query).toContain('matched_by_col');
  });

  it('counts an id with no board info, or on a third board, as neither a person nor an organization', async () => {
    const orphan = linkedItem('1', 'Donation', [{ id: '77', board: '999' }]);
    // 66 appears in linked_item_ids only (deleted/inaccessible); 55 sits on a third board.
    const link = orphan.column_values.find((c) => c.id === 'link_col')!;
    link.linked_item_ids = ['77', '66', '55'];
    (link as { linked_items: unknown }).linked_items = [
      { id: '77', board: { id: '999' } },
      { id: '55', board: { id: '4242' } },
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = orgClient([page([orphan])]);

    const result = await client.listYearActivity(2026, []);

    expect(result).toEqual({ personIds: ['77'], organizationIds: [] });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not request Matched By when it is the placeholder', async () => {
    const { client, sent } = orgClient([page([linkedItem('1', 'Donation', [{ id: '77', board: '999' }])])]);
    await client.listYearActivity(2026, []);
    expect(sent[0]!.query).not.toContain('REPLACE_WITH_COLUMN_ID');
  });
});

describe('HttpMondayClient.getCompletedVolunteerHoursInYear', () => {
  const shift = (id: string, person: string, hours: string, status: string, date = '2026-04-01') => ({
    id,
    column_values: [
      { id: 'vol_link_col', text: 'x', linked_item_ids: [person] },
      { id: 'vol_hours_col', text: hours },
      { id: 'vol_date_col', text: date },
      { id: 'vol_status_col', text: status },
    ],
  });

  it('sums completed hours per person across the Volunteers board', async () => {
    const { client, sent } = orgClient([
      page([shift('1', 'p1', '2.5', 'Completed'), shift('2', 'p1', '1', 'Completed'), shift('3', 'p2', '4', 'No show'), shift('4', 'p3', '3', 'Completed', '2025-12-31')]),
    ]);
    const hours = await client.getCompletedVolunteerHoursInYear(2026);
    expect([...hours]).toEqual([['p1', 3.5]]);
    expect(sent[0]!.variables).toMatchObject({ boardId: 3 });
  });
});

describe('Portal access column placeholder', () => {
  it('never sends REPLACE_WITH_COLUMN_ID and reports portalAccess false', async () => {
    const orgs = { ...orgReadCfg, organizations: { ...orgReadCfg.organizations, portalAccessColumn: 'REPLACE_WITH_COLUMN_ID' } };
    const item = affItem('1', { work: 'r@acme.org', portal: true });
    item.column_values = item.column_values.filter((c) => c.id !== 'portal_col');
    const { client, sent } = orgClient(
      [
        page([item]),
        { data: { items: [{ ...item, board: { id: '555' } }] } },
        page([item]),
        { data: { items: [{ id: 'p1', name: 'P', state: 'active', column_values: [{ id: 'people_aff', text: '', linked_item_ids: ['1'] }] }] } },
        { data: { items: [item] } },
      ],
      { orgs },
    );

    const [byEmail, one, listed] = [
      await client.findAffiliationsByWorkEmail('r@acme.org'),
      await client.getAffiliation('1'),
      await client.getOrganizationAffiliations('501'),
    ];
    const personAff = await client.getPersonAffiliations({ donorItemId: 'p1', employer: orgs.employer });

    expect(byEmail[0]!.portalAccess).toBe(false);
    expect(one!.portalAccess).toBe(false);
    expect(listed[0]!.portalAccess).toBe(false);
    expect(personAff[0]!.portalAccess).toBe(false);
    for (const body of sent) expect(body.query).not.toContain('REPLACE_WITH_COLUMN_ID');
  });
});
