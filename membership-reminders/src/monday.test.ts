// src/monday.test.ts
import { describe, it, expect, vi } from 'vitest';
import { MondayClient } from './monday';
import type { MondayColumns } from './types';

const columns: MondayColumns = {
  membershipStatus: 'status',
  membershipTier: 'tier',
  memberUntil: 'until',
  remindersSent: 'sent',
  email: 'email',
};

function fakeResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('MondayClient.queryDueMembers', () => {
  it('maps items and column values into Member objects', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      fakeResponse({
        data: {
          boards: [
            {
              items_page: {
                items: [
                  {
                    id: '123',
                    name: 'Jamie',
                    column_values: [
                      { id: 'email', text: 'jamie@example.org' },
                      { id: 'tier', text: 'Individual' },
                      { id: 'until', text: '2026-10-01' },
                      { id: 'sent', text: '4w:2026-04-01' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const client = new MondayClient('https://api.monday.com/v2', 'token', fetchFn);
    const members = await client.queryDueMembers(999, columns, 'Active', '2026-10-01');
    expect(members).toEqual([
      {
        id: '123',
        name: 'Jamie',
        email: 'jamie@example.org',
        membershipTier: 'Individual',
        memberUntil: '2026-10-01',
        remindersSent: '4w:2026-04-01',
      },
    ]);
  });

  it('throws when the response has GraphQL errors', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ errors: [{ message: 'bad column' }] }));
    const client = new MondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await expect(client.queryDueMembers(999, columns, 'Active', '2026-10-01')).rejects.toThrow(
      'bad column',
    );
  });

  it('throws on a non-ok HTTP response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({}, false, 500));
    const client = new MondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await expect(client.queryDueMembers(999, columns, 'Active', '2026-10-01')).rejects.toThrow(
      'HTTP 500',
    );
  });
});

describe('MondayClient.stampReminderSent', () => {
  it('posts a mutation with the item id, column id, and new value', async () => {
    const fetchFn = vi.fn().mockResolvedValue(fakeResponse({ data: { change_simple_column_value: { id: '123' } } }));
    const client = new MondayClient('https://api.monday.com/v2', 'token', fetchFn);
    await client.stampReminderSent('123', 999, 'sent', '6w:2026-10-01');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchFn.mock.calls[0];
    const body = JSON.parse(requestInit.body as string);
    expect(body.variables).toEqual({
      boardId: 999,
      itemId: '123',
      columnId: 'sent',
      value: '6w:2026-10-01',
    });
  });
});
