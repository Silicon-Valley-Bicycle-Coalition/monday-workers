import { describe, it, expect, vi } from 'vitest';
import { matchDonor } from './donors';
import type { MondayClient } from '../monday/client';
import { testConfig } from '../test/testConfig';

const config = testConfig();

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'new-item' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems: vi.fn(), notify: vi.fn(), postUpdate: vi.fn(),
    ...overrides,
  };
}

describe('matchDonor', () => {
  it('matches an existing People item by the bare email address', async () => {
    const findItemByColumnValue = vi.fn().mockResolvedValue({ id: 'person-1' });
    const client = fakeMondayClient({ findItemByColumnValue });

    const result = await matchDonor(client, config, { email: ' jane@example.com ', name: 'Jane Rider' });

    expect(result).toEqual({ donorItemId: 'person-1', created: false });
    expect(findItemByColumnValue).toHaveBeenCalledWith(42, 'email_col', 'jane@example.com');
    expect(client.createItem).not.toHaveBeenCalled();
  });

  it('creates a People item with the name and the { email, text } shape when nothing matches', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: 'person-new' });
    const client = fakeMondayClient({ createItem });

    const result = await matchDonor(client, config, { email: 'jane@example.com', name: 'Jane Rider' });

    expect(result).toEqual({ donorItemId: 'person-new', created: true });
    expect(createItem).toHaveBeenCalledWith(42, 'Jane Rider', { email_col: { email: 'jane@example.com', text: 'jane@example.com' } });
  });

  it('names a buyer without a name "Unknown Donor"', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: 'person-new' });
    await matchDonor(fakeMondayClient({ createItem }), config, { email: 'x@example.com', name: null });
    expect(createItem).toHaveBeenCalledWith(42, 'Unknown Donor', expect.anything());
  });

  it('returns no donor, without any Monday call, when the order has no email', async () => {
    const client = fakeMondayClient();
    const result = await matchDonor(client, config, { email: '', name: 'Jane Rider' });
    expect(result).toEqual({ donorItemId: null, reason: 'order has no email' });
    expect(client.findItemByColumnValue).not.toHaveBeenCalled();
    expect(client.createItem).not.toHaveBeenCalled();
  });

  it('throws when the People board is not configured', async () => {
    await expect(matchDonor(fakeMondayClient(), testConfig({}, { 'people-live': null }), { email: 'x@example.com', name: 'X' })).rejects.toThrow('people-live');
  });

  it('propagates a Monday failure so the consumer retries', async () => {
    const client = fakeMondayClient({ findItemByColumnValue: vi.fn().mockRejectedValue(new Error('monday API: HTTP 429')) });
    await expect(matchDonor(client, config, { email: 'x@example.com', name: 'X' })).rejects.toThrow('HTTP 429');
  });
});
