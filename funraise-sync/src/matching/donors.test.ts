import { describe, it, expect, vi } from 'vitest';
import { matchDonor } from './donors';
import type { MondayClient, MondayItem } from '../monday/client';
import type { FunraiseSyncConfig } from '../types';

const config: FunraiseSyncConfig = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    boards: { 'donations:live': 1, 'recurring-gifts': null, 'event-registrations': null, 'people-live': 42 },
  },
  funraiseSync: {
    columnMap: { transaction: {}, recurringGift: {}, registration: {} },
    entityIdField: {
      transaction: 'id',
      recurringGift: 'id',
      registration: 'id',
    },
    entityIdColumn: null,
    thankYouSentColumn: null,
    giftTypeColumn: null,
    giftTypeValue: 'Donation',
    fiscalYearColumn: null,
    rawPayloadRetentionDays: 90,
    unresolvedPayloadRetentionDays: 365,
    itemNameField: {
      transaction: 'description',
      recurringGift: 'description',
      registration: 'eventName',
    },
    donorExternalIdField: 'donor.contactId',
    donorExternalIdColumn: 'funraise_id_col',
    donorEmailColumn: 'email_col',
    donorNameField: 'donor.name',
    donorLinkColumn: 'connect_col',
    emailFieldPrecedence: ['donor.email'],
    statusField: 'status',
    statusValueMap: {},
    doNotMigrateFields: [],
  },
};

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

  it('throws when the Donors board is not configured', async () => {
    const client = fakeMondayClient();
    const unconfigured = { ...config, monday: { ...config.monday, boards: { ...config.monday.boards, 'people-live': null } } };
    await expect(matchDonor(client, unconfigured, { donor: { email: 'x@example.com' } })).rejects.toThrow(
      /people-live.*not configured/
    );
  });
});
