import { describe, it, expect, vi } from 'vitest';
import { matchDonor } from './donors';
import { MondayApiError } from '../monday/graphql';
import { dryRunMondayClient, piiKeysFor } from '../writeSwitch';
import type { MondayClient, MondayItem } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';
import { testConfig } from '../test/testConfig';

const config = testConfig({ columnMap: {} }, { 'donations:live': 1 });

function fakeMondayClient(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'new-item' } satisfies MondayItem),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('matchDonor', () => {
  it('matches by external id first, without checking email', async () => {
    const findItemByColumnValue = vi.fn().mockResolvedValue({ id: 'donor-1' });
    const client = fakeMondayClient({ findItemByColumnValue });

    const result = await matchDonor(client, config, { donor: { contactId: 'fr-1', email: 'a@example.com' } });

    expect(result).toEqual({ donorItemId: 'donor-1', created: false });
    expect(findItemByColumnValue).toHaveBeenCalledTimes(1);
    expect(findItemByColumnValue).toHaveBeenCalledWith(42, 'funraise_id_col', 'fr-1');
  });

  it('falls back to email match when external id has no match', async () => {
    const findItemByColumnValue = vi
      .fn()
      .mockResolvedValueOnce(null) // external id lookup
      .mockResolvedValueOnce({ id: 'donor-2' }); // email lookup
    const client = fakeMondayClient({ findItemByColumnValue });

    const result = await matchDonor(client, config, { donor: { contactId: 'fr-2', email: 'b@example.com' } });

    expect(result).toEqual({ donorItemId: 'donor-2', created: false });
    expect(findItemByColumnValue).toHaveBeenNthCalledWith(2, 42, 'email_col', 'b@example.com');
  });

  it('auto-creates a new donor when neither external id nor email match', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: 'donor-new' });
    const client = fakeMondayClient({ createItem });

    const result = await matchDonor(client, config, {
      donor: { contactId: 'fr-3', email: 'c@example.com', name: 'Casey Donor' },
    });

    expect(result).toEqual({ donorItemId: 'donor-new', created: true });
    // Monday rejects bare strings on email and link columns: the People board's Personal
    // Email is an email column and Funraise Profile is a link column (the supporter URL with
    // the bare id as its text, the same shape salesforce-import writes).
    expect(createItem).toHaveBeenCalledWith(42, 'Casey Donor', {
      email_col: { email: 'c@example.com', text: 'c@example.com' },
      funraise_id_col: { url: 'https://platform.funraise.io/supporter/fr-3', text: 'fr-3' },
    });
  });

  it('matches and creates on a numeric supporter id, as Funraise sends it', async () => {
    const supporterConfig: FunraiseSyncConfig = {
      ...config,
      funraiseSync: { ...config.funraiseSync, donorExternalIdField: 'supporter.id', emailFieldPrecedence: ['supporter.email'] },
    };
    const findItemByColumnValue = vi.fn().mockResolvedValue(null);
    const createItem = vi.fn().mockResolvedValue({ id: 'donor-new' });
    const client = fakeMondayClient({ findItemByColumnValue, createItem });

    await matchDonor(client, supporterConfig, { supporter: { id: 7276, email: 'debbie@example.com' } });

    expect(findItemByColumnValue).toHaveBeenNthCalledWith(1, 42, 'funraise_id_col', '7276');
    expect(createItem).toHaveBeenCalledWith(42, 'Unknown Donor', {
      email_col: { email: 'debbie@example.com', text: 'debbie@example.com' },
      funraise_id_col: { url: 'https://platform.funraise.io/supporter/7276', text: '7276' },
    });
  });

  it('falls back to "Unknown Donor" when no name field is present', async () => {
    const createItem = vi.fn().mockResolvedValue({ id: 'donor-new' });
    const client = fakeMondayClient({ createItem });

    await matchDonor(client, config, { donor: { contactId: 'fr-4', email: 'd@example.com' } });

    expect(createItem).toHaveBeenCalledWith(42, 'Unknown Donor', expect.any(Object));
  });

  describe('names on a new person', () => {
    const payload = (donor: Record<string, unknown>) => ({ donor: { contactId: 'fr-5', email: 'e@example.com', name: 'Ada Lovelace', ...donor } });

    it('creates the person as before, then writes both names separately', async () => {
      const createItem = vi.fn().mockResolvedValue({ id: 'new-item' });
      const changeColumnValues = vi.fn().mockResolvedValue(undefined);
      const client = fakeMondayClient({ createItem, changeColumnValues });

      const result = await matchDonor(client, config, payload({ firstName: 'Ada', lastName: 'Lovelace' }));

      expect(result).toEqual({ donorItemId: 'new-item', created: true });
      expect(Object.keys(createItem.mock.calls[0]![2])).toEqual(['email_col', 'funraise_id_col']);
      expect(changeColumnValues).toHaveBeenCalledWith(42, 'new-item', { first_col: 'Ada', last_col: 'Lovelace' });
    });

    it('omits a blank part, treating spaces as blank', async () => {
      const changeColumnValues = vi.fn().mockResolvedValue(undefined);
      const client = fakeMondayClient({ changeColumnValues });

      await matchDonor(client, config, payload({ firstName: '   ', lastName: ' Lovelace ' }));

      expect(changeColumnValues).toHaveBeenCalledWith(42, 'new-item', { last_col: 'Lovelace' });
    });

    it('makes no name write when the source has neither part', async () => {
      const changeColumnValues = vi.fn().mockResolvedValue(undefined);
      await matchDonor(fakeMondayClient({ changeColumnValues }), config, payload({}));
      expect(changeColumnValues).not.toHaveBeenCalled();
    });

    it('never writes names on a matched person', async () => {
      const changeColumnValues = vi.fn().mockResolvedValue(undefined);
      const client = fakeMondayClient({ changeColumnValues, findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'donor-1' }) });
      await matchDonor(client, config, payload({ firstName: 'Ada', lastName: 'Lovelace' }));
      expect(changeColumnValues).not.toHaveBeenCalled();
    });

    it('still returns the person when the name write fails, logging the id and not the name', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failure = new MondayApiError('column_values rejected: Ada', { httpStatus: 200, code: 'ColumnValueException' });
      const client = fakeMondayClient({ changeColumnValues: vi.fn().mockRejectedValue(failure) });

      const result = await matchDonor(client, config, payload({ firstName: 'Ada', lastName: 'Lovelace' }));

      expect(result).toEqual({ donorItemId: 'new-item', created: true });
      const logged = warn.mock.calls.flat().join(' ');
      expect(logged).toContain('new-item');
      expect(logged).toContain('ColumnValueException');
      expect(logged).not.toContain('Ada');
      warn.mockRestore();
    });

    it('stays a dry run under the write switch, with the name masked in debug logs', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const changeColumnValues = vi.fn().mockResolvedValue(undefined);
      const real = fakeMondayClient({ changeColumnValues });
      const ctx = { worker: 'funraise-sync', environment: 'sandbox', mode: 'off' as const, logLevel: 'debug' as const, deliveryId: 'd', piiKeys: piiKeysFor(config) };
      const dry = dryRunMondayClient(real, config.monday.boards, ctx);

      const result = await matchDonor(dry, config, payload({ firstName: 'Ada', lastName: 'Lovelace' }));

      expect(result).toEqual({ donorItemId: 'dry-run-1', created: true });
      expect(changeColumnValues).not.toHaveBeenCalled();
      const logged = log.mock.calls.flat().join(' ');
      expect(logged).toContain('changeColumnValues');
      expect(logged).not.toContain('Ada');
      log.mockRestore();
    });
  });

  it('throws when the Donors board is not configured', async () => {
    const client = fakeMondayClient();
    const unconfigured = { ...config, monday: { ...config.monday, boards: { ...config.monday.boards, 'people-live': null } } };
    await expect(matchDonor(client, unconfigured, { donor: { email: 'x@example.com' } })).rejects.toThrow(
      /people-live.*not configured/
    );
  });
});
