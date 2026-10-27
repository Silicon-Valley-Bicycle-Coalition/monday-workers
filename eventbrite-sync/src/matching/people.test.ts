import { describe, it, expect, vi } from 'vitest';
import { matchPerson } from './people';
import type { MondayClient } from '../monday/client';

function fakeClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'new' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems: vi.fn().mockResolvedValue([]),
    notify: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('matchPerson', () => {
  it('returns no match, without a Monday call, when there is no email', async () => {
    const client = fakeClient();
    expect(await matchPerson(client, 42, 'email_col', { email: '  ', name: 'Jane' })).toEqual({ donorItemId: null, reason: 'no email' });
    expect(client.findItemByColumnValue).not.toHaveBeenCalled();
  });

  it('matches an existing item by the trimmed email', async () => {
    const client = fakeClient({ findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'p1' }) });
    expect(await matchPerson(client, 42, 'email_col', { email: ' a@example.com ', name: 'A' })).toEqual({ donorItemId: 'p1', created: false });
    expect(client.findItemByColumnValue).toHaveBeenCalledWith(42, 'email_col', 'a@example.com');
  });

  it('creates the person with the { email, text } shape when nothing matches', async () => {
    const client = fakeClient();
    expect(await matchPerson(client, 42, 'email_col', { email: 'a@example.com', name: ' Ann ' })).toEqual({ donorItemId: 'new', created: true });
    expect(client.createItem).toHaveBeenCalledWith(42, 'Ann', { email_col: { email: 'a@example.com', text: 'a@example.com' } });
  });
});
