import { describe, it, expect, vi } from 'vitest';
import { matchDonor } from './donors';
import type { MondayClient } from '../monday/client';
import { testConfig } from '../test/testConfig';
import { dryRunMondayClient, piiKeysFor } from '../writeSwitch';

const config = testConfig();

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'new-item' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems: vi.fn(), postUpdate: vi.fn(), createTimelineItem: vi.fn(),
    ...overrides,
  };
}

describe('matchDonor names', () => {
  const buyer = { email: 'a@example.com', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace' };

  it('passes the order\'s first and last name to the new person\'s columns', async () => {
    const client = fakeMondayClient();
    await matchDonor(client, config, buyer);
    expect(client.createItem).toHaveBeenCalledWith(42, 'Ada Lovelace', { email_col: { email: 'a@example.com', text: 'a@example.com' } });
    expect(client.changeColumnValues).toHaveBeenCalledWith(42, 'new-item', { first_col: 'Ada', last_col: 'Lovelace' });
  });

  it('stays a dry run under the write switch, with the name masked in debug logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const real = fakeMondayClient();
    const ctx = { worker: 'eventbrite-sync', environment: 'sandbox', mode: 'off' as const, logLevel: 'debug' as const, deliveryId: 'd', piiKeys: piiKeysFor(config) };

    const result = await matchDonor(dryRunMondayClient(real, config.monday.boards, ctx), config, buyer);

    expect(result).toEqual({ donorItemId: 'dry-run-1', created: true });
    expect(real.changeColumnValues).not.toHaveBeenCalled();
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('changeColumnValues');
    expect(logged).not.toContain('Ada');
    log.mockRestore();
  });
});

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
