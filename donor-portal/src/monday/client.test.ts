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
};

function fetchReturning(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
}

describe('HttpMondayClient.findDonorsByEmail', () => {
  it('returns every matching donor item', async () => {
    const fetchMock = fetchReturning({
      data: {
        boards: [{ items_page: { items: [{ id: '1', name: 'Jane' }, { id: '2', name: 'Jane Also' }] } }],
      },
    });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);

    const matches = await client.findDonorsByEmail('shared@example.org');

    expect(matches).toEqual([
      { id: '1', name: 'Jane' },
      { id: '2', name: 'Jane Also' },
    ]);
  });

  it('returns an empty array when nothing matches', async () => {
    const fetchMock = fetchReturning({ data: { boards: [{ items_page: { items: [] } }] } });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);

    expect(await client.findDonorsByEmail('nobody@example.org')).toEqual([]);
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

    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);

    const data = await client.getDonorPortalData('donor-1');

    expect(data).toEqual({
      id: 'donor-1',
      name: 'Jane Donor',
      membershipStatus: 'Active',
      membershipTier: 'Member',
      totalDonated: '500',
      donations: [{ amount: '100', date: '2026-01-01', description: 'Annual gift' }],
    });
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
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);

    const orgs = await client.getDiscountOrganizations();

    expect(orgs).toEqual([{ name: 'Local Bikes', discountOffered: '10% off' }]);
  });
});

describe('HttpMondayClient error handling', () => {
  it('throws on a non-OK HTTP response', async () => {
    const fetchMock = fetchReturning({}, false);
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/HTTP 500/);
  });

  it('throws on a GraphQL errors array', async () => {
    const fetchMock = fetchReturning({ errors: [{ message: 'Board not found' }] });
    const client = new HttpMondayClient('https://api.monday.com/v2', 'token', columns, 999, 1, 2, fetchMock);
    await expect(client.findDonorsByEmail('x@example.org')).rejects.toThrow(/Board not found/);
  });
});
