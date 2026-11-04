import { describe, it, expect, vi } from 'vitest';
import { consumeFunraiseBatch, processFunraiseQueueBatch, TERMINAL_PREFIX, type QueueMessageLike, type FunraiseQueueMessage } from './processBatch';
import { MondayApiError } from '../monday/graphql';
import type { SubscriptionStore } from '../db/subscriptions';
import type { FunraiseClient } from '../funraise/client';
import type { WriteMode } from '../flags';
import type { BatchSkipContext } from '../writeSwitch';
import type { EventStore } from '../db/events';
import type { MondayClient } from '../monday/client';
import type { EventRow, FunraiseSyncConfig } from '../types';
import { testConfig } from '../test/testConfig';

const config: FunraiseSyncConfig = testConfig({ entityIdColumn: 'entity_col' });

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId: 'evt-1',
    entityType: 'transaction',
    entityId: 'txn-1',
    rawPayload: JSON.stringify({ amount: 100, donor: { contactId: 'fr-1', email: 'a@b.org', name: 'Ada' } }),
    matchedDonorItemId: null,
    mondayItemId: null,
    status: 'queued',
    error: null,
    receivedAt: '2026-08-22T00:00:00.000Z',
    writtenAt: null,
    ...overrides,
  };
}

function fakeStore(row: EventRow | null): EventStore {
  return {
    upsertEvent: vi.fn(),
    updateStatusByEntity: vi.fn().mockResolvedValue(undefined),
    getEventByEntity: vi.fn().mockResolvedValue(row),
    purgeWrittenPayloads: vi.fn(),
    purgeUnresolvedPayloads: vi.fn().mockResolvedValue(0),
  };
}

function fakeMessage(
  entityType: FunraiseQueueMessage['entityType'] = 'transaction',
  entityId = 'txn-1'
): QueueMessageLike<FunraiseQueueMessage> & { ack: any; retry: any } {
  return { body: { entityType, entityId }, ack: vi.fn(), retry: vi.fn() };
}

describe('processFunraiseQueueBatch', () => {
  it('matches the donor in the consumer, records the match, creates the item, and marks written', async () => {
    const eventStore = fakeStore(eventRow());
    const createItem = vi.fn().mockResolvedValue({ id: 'item-1' });
    // Donor lookup on the Donors board (42) hits; the orphan pre-create lookup on the target board misses.
    const findItemByColumnValue = vi.fn().mockImplementation(async (boardId: number) =>
      boardId === 42 ? { id: '55' } : null
    );
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues: vi.fn() };
    const message = fakeMessage();

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(findItemByColumnValue).toHaveBeenCalledWith(42, 'funraise_id_col', 'fr-1');
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'matched', {
      matchedDonorItemId: '55',
    });
    expect(createItem).toHaveBeenCalledWith(111, 'Funraise transaction', {
      numeric_col: 100,
      connect_col: { item_ids: [55] },
      entity_col: { url: 'https://platform.funraise.io/transaction/txn-1', text: 'txn-1' },
    });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'written', {
      mondayItemId: 'item-1',
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('skips donor matching when the event already has a matched donor', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const findItemByColumnValue = vi.fn();
    const createItem = vi.fn().mockResolvedValue({ id: 'item-2' });
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    // No donor lookups on the Donors board (42) — the only find call is the pre-create
    // orphan check on the target board.
    expect(findItemByColumnValue).not.toHaveBeenCalledWith(42, expect.anything(), expect.anything());
    expect(createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({
      connect_col: { item_ids: [7] },
    }));
  });

  it('updates the existing Monday item instead of creating when the event already has one', async () => {
    const eventStore = fakeStore(
      eventRow({ matchedDonorItemId: '7', mondayItemId: 'item-existing', rawPayload: JSON.stringify({ amount: 50 }) })
    );
    const createItem = vi.fn();
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues };
    const message = fakeMessage();

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(createItem).not.toHaveBeenCalled();
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', {
      numeric_col: 50,
      connect_col: { item_ids: [7] },
      entity_col: { url: 'https://platform.funraise.io/transaction/txn-1', text: 'txn-1' },
    });
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'written', {
      writtenAt: expect.any(String),
    });
    expect(message.ack).toHaveBeenCalled();
  });

  it('marks the event failed and retries the message on a donor-match failure', async () => {
    const eventStore = fakeStore(eventRow());
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockRejectedValue(new Error('monday API: HTTP 429')),
      createItem: vi.fn(),
      changeColumnValues: vi.fn(),
    };
    const message = fakeMessage();

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'failed', {
      error: 'monday API: HTTP 429',
    });
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('marks the event failed and retries the message on a Monday write failure', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn(),
      createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
      changeColumnValues: vi.fn(),
    };
    const message = fakeMessage();

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'failed', {
      error: 'monday API: HTTP 500',
    });
    expect(message.retry).toHaveBeenCalled();
  });

  it('uses the description field as the item name when present', async () => {
    const eventStore = fakeStore(
      eventRow({ matchedDonorItemId: '7', rawPayload: JSON.stringify({ amount: 50, description: 'Monthly gift' }) })
    );
    const createItem = vi.fn().mockResolvedValue({ id: 'item-4' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(111, 'Monthly gift', expect.any(Object));
  });

  it('fails and retries when the D1 row is missing', async () => {
    const eventStore = fakeStore(null);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem: vi.fn(), changeColumnValues: vi.fn() };
    const message = fakeMessage('transaction', 'missing-txn');

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'missing-txn', 'failed', {
      error: expect.any(String),
    });
  });
});

describe('create idempotency via the entity-id column', () => {
  it('stamps the entity id column on created items', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const findItemByColumnValue = vi.fn().mockResolvedValue(null);
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({
      entity_col: { url: 'https://platform.funraise.io/transaction/txn-1', text: 'txn-1' },
    }));
  });

  it('recovers an orphaned Monday item (created but never recorded) instead of duplicating it', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn();
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const findItemByColumnValue = vi.fn().mockResolvedValue({ id: 'item-orphan' });
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    expect(findItemByColumnValue).toHaveBeenCalledWith(111, 'entity_col', 'txn-1');
    expect(createItem).not.toHaveBeenCalled();
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-orphan', expect.any(Object));
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'written', {
      mondayItemId: 'item-orphan',
      writtenAt: expect.any(String),
    });
  });

  it('adopts a gift salesforce-import migrated (first Funraise update after cutover, no D1 row) instead of duplicating it', async () => {
    // A refund of a pre-cutover gift: no mondayItemId in D1, but the imported Donations item
    // carries the same Funraise transaction link, found by its bare id.
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn();
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const findItemByColumnValue = vi.fn().mockResolvedValue({ id: 'item-migrated' });
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    expect(findItemByColumnValue).toHaveBeenCalledWith(111, 'entity_col', 'txn-1');
    expect(createItem).not.toHaveBeenCalled();
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-migrated', {
      numeric_col: 100,
      entity_col: { url: 'https://platform.funraise.io/transaction/txn-1', text: 'txn-1' },
    });
  });

  it('never overwrites the Donor link when adopting — the importer may have linked an Organization', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'item-migrated' }),
      createItem: vi.fn(),
      changeColumnValues,
    };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-migrated',
      expect.not.objectContaining({ connect_col: expect.anything() }));
  });

  it('writes the entity id as a link { url, text } — the Donations Funraise ID column rejects a bare string', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn().mockResolvedValue(null), createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    const cols = createItem.mock.calls[0]![2] as Record<string, unknown>;
    expect(typeof cols['entity_col']).toBe('object');
  });

  it('creates directly without a lookup when entityIdColumn is null', async () => {
    const noColumnConfig = {
      ...config,
      funraiseSync: { ...config.funraiseSync, entityIdColumn: null },
    };
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const findItemByColumnValue = vi.fn();
    const mondayClient: MondayClient = { findItemByColumnValue, createItem, changeColumnValues: vi.fn() };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: noColumnConfig });

    expect(findItemByColumnValue).not.toHaveBeenCalled();
    expect(createItem).toHaveBeenCalled();
  });
});

describe('Thank You Sent (acknowledgment decision, Option 2)', () => {
  const thankYouConfig: FunraiseSyncConfig = {
    ...config,
    funraiseSync: { ...config.funraiseSync, thankYouSentColumn: 'thank_you_col' },
  };

  it('sets Thank You Sent true when creating a Donations item', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue(null),
      createItem,
      changeColumnValues: vi.fn(),
    };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: thankYouConfig });

    expect(createItem).toHaveBeenCalledWith(
      111,
      expect.any(String),
      expect.objectContaining({ thank_you_col: { checked: 'true' } })
    );
  });

  it('never re-stamps Thank You Sent when adopting an existing item (a migrated gift, or our own orphan that already has it)', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'item-orphan' }),
      createItem: vi.fn(),
      changeColumnValues,
    };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: thankYouConfig });

    expect(changeColumnValues).toHaveBeenCalledWith(
      111,
      'item-orphan',
      expect.not.objectContaining({ thank_you_col: expect.anything() })
    );
  });

  it('never touches Thank You Sent on a later update to an already-written item', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7', mondayItemId: 'item-existing' }));
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem: vi.fn(), changeColumnValues };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: thankYouConfig });

    expect(changeColumnValues).toHaveBeenCalledWith(
      111,
      'item-existing',
      expect.not.objectContaining({ thank_you_col: expect.anything() })
    );
  });

  it('does nothing when thankYouSentColumn is not configured', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue(null),
      createItem,
      changeColumnValues: vi.fn(),
    };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });

    expect(createItem).toHaveBeenCalledWith(
      111,
      expect.any(String),
      expect.not.objectContaining({ thank_you_col: expect.anything() })
    );
  });
});

describe('Gift Type stamp (membership renewal write path, spec 2026-09-15)', () => {
  const giftTypeConfig: FunraiseSyncConfig = {
    ...config,
    funraiseSync: { ...config.funraiseSync, giftTypeColumn: 'gt_col', giftTypeValue: 'Donation' },
  };

  it('stamps Gift Type when creating a Donations item', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn().mockResolvedValue(null), createItem, changeColumnValues: vi.fn() };
    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: giftTypeConfig });
    expect(createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({ gt_col: 'Donation' }));
  });

  it('never re-stamps Gift Type when adopting an existing item — a migrated gift keeps its Salesforce classification', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'item-orphan' }), createItem: vi.fn(), changeColumnValues };
    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: giftTypeConfig });
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-orphan', expect.not.objectContaining({ gt_col: expect.anything() }));
  });

  it('never touches Gift Type on a later update — staff may have reclassified the gift', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7', mondayItemId: 'item-existing' }));
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem: vi.fn(), changeColumnValues };
    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: giftTypeConfig });
    expect(changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', expect.not.objectContaining({ gt_col: expect.anything() }));
  });

  it('does nothing when giftTypeColumn is null', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn().mockResolvedValue(null), createItem, changeColumnValues: vi.fn() };
    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config });
    expect(createItem).toHaveBeenCalledWith(111, expect.any(String), expect.not.objectContaining({ gt_col: expect.anything() }));
  });
});

describe('Fiscal Year Ending (derived column, decision 2026-09-17)', () => {
  const fiscalYearConfig: FunraiseSyncConfig = {
    ...config,
    funraiseSync: { ...config.funraiseSync, fiscalYearColumn: 'fiscal_year_col' },
  };

  // Funraise's transaction date field is `donationDate`, sent as epoch milliseconds; an ISO
  // string is accepted too (see toISODate), which keeps these fixtures readable.
  function transactionRow(donationDate: unknown, overrides: Partial<EventRow> = {}): EventRow {
    return eventRow({
      matchedDonorItemId: '7',
      rawPayload: JSON.stringify({ amount: 100, donationDate, donor: { contactId: 'fr-1' } }),
      ...overrides,
    });
  }

  function clientForCreate(createItem: MondayClient['createItem']): MondayClient {
    return {
      findItemByColumnValue: vi.fn().mockResolvedValue(null),
      createItem,
      changeColumnValues: vi.fn(),
    };
  }

  it('writes the mapped Date column as a YYYY-MM-DD date object from the epoch-ms donationDate, and the fiscal year from the same date', async () => {
    const dateConfig: FunraiseSyncConfig = {
      ...fiscalYearConfig,
      funraiseSync: {
        ...fiscalYearConfig.funraiseSync,
        columnMap: { amount: 'numeric_col', donationDate: 'date_col' },
      },
    };
    // 2026-08-15T18:30:12Z — August, so fiscal year 2027.
    const eventStore = fakeStore(transactionRow(1786818612000));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient: clientForCreate(createItem), config: dateConfig });

    expect(createItem).toHaveBeenCalledWith(
      111,
      expect.any(String),
      expect.objectContaining({ date_col: { date: '2026-08-15' }, fiscal_year_col: '2027' })
    );
  });

  it('leaves the mapped Date column out when donationDate is unparseable, instead of writing a raw number', async () => {
    const dateConfig: FunraiseSyncConfig = {
      ...fiscalYearConfig,
      funraiseSync: {
        ...fiscalYearConfig.funraiseSync,
        columnMap: { donationDate: 'date_col' },
      },
    };
    const eventStore = fakeStore(transactionRow('not a date'));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient: clientForCreate(createItem), config: dateConfig });

    expect(createItem).toHaveBeenCalledWith(
      111,
      expect.any(String),
      expect.not.objectContaining({ date_col: expect.anything() })
    );
  });

  it('stamps the fiscal year (July rule) as a string when creating a Donations item', async () => {
    const eventStore = fakeStore(transactionRow('2026-08-15T18:30:12.000Z'));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });

    await processFunraiseQueueBatch([fakeMessage()], {
      eventStore,
      mondayClient: clientForCreate(createItem),
      config: fiscalYearConfig,
    });

    expect(createItem).toHaveBeenCalledWith(
      111,
      expect.any(String),
      expect.objectContaining({ fiscal_year_col: '2027' })
    );
  });

  it('keeps a June gift in the fiscal year that ends that month', async () => {
    const eventStore = fakeStore(transactionRow('2026-06-30T12:00:00.000Z'));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });

    await processFunraiseQueueBatch([fakeMessage()], {
      eventStore,
      mondayClient: clientForCreate(createItem),
      config: fiscalYearConfig,
    });

    expect(createItem).toHaveBeenCalledWith(
      111,
      expect.any(String),
      expect.objectContaining({ fiscal_year_col: '2026' })
    );
  });

  it('never re-stamps the fiscal year when adopting an existing item', async () => {
    const eventStore = fakeStore(transactionRow('2026-08-15T18:30:12.000Z'));
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'item-orphan' }),
      createItem: vi.fn(),
      changeColumnValues,
    };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: fiscalYearConfig });

    expect(changeColumnValues).toHaveBeenCalledWith(
      111,
      'item-orphan',
      expect.not.objectContaining({ fiscal_year_col: expect.anything() })
    );
  });

  it('never touches the fiscal year on a later update to an already-written item', async () => {
    const eventStore = fakeStore(transactionRow('2026-08-15T18:30:12.000Z', { mondayItemId: 'item-existing' }));
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem: vi.fn(), changeColumnValues };

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: fiscalYearConfig });

    expect(changeColumnValues).toHaveBeenCalledWith(
      111,
      'item-existing',
      expect.not.objectContaining({ fiscal_year_col: expect.anything() })
    );
  });

  it('leaves the column out (and still creates) when donationDate is missing or unparseable', async () => {
    for (const donationDate of [undefined, 'not a date']) {
      const eventStore = fakeStore(transactionRow(donationDate));
      const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });

      await processFunraiseQueueBatch([fakeMessage()], {
        eventStore,
        mondayClient: clientForCreate(createItem),
        config: fiscalYearConfig,
      });

      expect(createItem).toHaveBeenCalledWith(
        111,
        expect.any(String),
        expect.not.objectContaining({ fiscal_year_col: expect.anything() })
      );
      expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith(
        'transaction',
        'txn-1',
        'written',
        expect.objectContaining({ mondayItemId: 'item-new' })
      );
    }
  });

  it('does nothing when fiscalYearColumn is not configured', async () => {
    const eventStore = fakeStore(transactionRow('2026-08-15T18:30:12.000Z'));
    const createItem = vi.fn().mockResolvedValue({ id: 'item-new' });

    await processFunraiseQueueBatch([fakeMessage()], {
      eventStore,
      mondayClient: clientForCreate(createItem),
      config,
    });

    expect(createItem).toHaveBeenCalledWith(111, expect.any(String), {
      numeric_col: 100,
      connect_col: { item_ids: [7] },
      entity_col: { url: 'https://platform.funraise.io/transaction/txn-1', text: 'txn-1' },
    });
  });
});

// #25: retries were immediate, so a Monday outage of more than a few seconds burned all three
// attempts at once and dead-lettered the gift. They now back off by attempt number, with the
// shared write-switch delay (1 min doubling, capped at 1 h; flags.ts retryDelaySeconds) across
// max_retries 100 — about four days of cover.
describe('retry backoff', () => {

  it('retries a failed message with the delay for its attempt number', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn(),
      createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
      changeColumnValues: vi.fn(),
    };
    const message = { ...fakeMessage(), attempts: 2 };

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
  });

  it('caps the delay at an hour once a retryable Monday failure reaches attempt 8', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const mondayClient: MondayClient = {
      findItemByColumnValue: vi.fn(),
      createItem: vi.fn().mockRejectedValue(new Error('monday API: HTTP 503')),
      changeColumnValues: vi.fn(),
    };
    const message = { ...fakeMessage(), attempts: 8 };

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 3600 });
  });

  it('still retries the message (with backoff) when recording the failure in D1 also fails', async () => {
    const eventStore = fakeStore(null);
    (eventStore.updateStatusByEntity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1_ERROR: overloaded'));
    const mondayClient: MondayClient = { findItemByColumnValue: vi.fn(), createItem: vi.fn(), changeColumnValues: vi.fn() };
    const message = { ...fakeMessage(), attempts: 1 };

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });
});

// #75: a Monday rejection of the write itself (a 4xx, a column value it won't take) fails the same
// way on every retry, so it is recorded and acked instead of retried for four days into the DLQ.
describe('terminal failures', () => {
  const rejectingMonday = (err: Error): MondayClient => ({
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockRejectedValue(err),
    changeColumnValues: vi.fn(),
  });

  it('records a rejected column value as not retried and acks the message', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const message = { ...fakeMessage(), attempts: 1 };

    await processFunraiseQueueBatch([message], {
      eventStore,
      mondayClient: rejectingMonday(new MondayApiError('monday API: invalid value', { httpStatus: 200, code: 'ColumnValueException' })),
      config,
    });

    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'failed', {
      error: `${TERMINAL_PREFIX}monday API: invalid value`,
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('still retries a rejected token (HTTP 401) — fixing the secret heals the backlog', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    const message = { ...fakeMessage(), attempts: 1 };

    await processFunraiseQueueBatch([message], {
      eventStore,
      mondayClient: rejectingMonday(new MondayApiError('monday API: HTTP 401', { httpStatus: 401 })),
      config,
    });

    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'failed', { error: 'monday API: HTTP 401' });
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('retries a terminal failure it could not record, so it is not lost silently', async () => {
    const eventStore = fakeStore(eventRow({ matchedDonorItemId: '7' }));
    (eventStore.updateStatusByEntity as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('D1_ERROR: overloaded'));
    const message = { ...fakeMessage(), attempts: 1 };

    await processFunraiseQueueBatch([message], {
      eventStore,
      mondayClient: rejectingMonday(new MondayApiError('monday API: HTTP 400', { httpStatus: 400 })),
      config,
    });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });
});

describe('archived-gift check (oldestActiveFiscalYear)', () => {
  // The importer keeps FY 2026 and later active, so a gift dated before 2025-07-01 may have been
  // archived, where the adopt lookup can't see it.
  const archivedConfig: FunraiseSyncConfig = {
    ...config,
    funraiseSync: { ...config.funraiseSync, entityIdColumn: 'funraise_id_col', oldestActiveFiscalYear: 2026 },
  };

  const row = (donationDate: unknown) =>
    eventRow({
      matchedDonorItemId: '7',
      rawPayload: JSON.stringify({ amount: 100, donationDate, donor: { contactId: 'fr-1' } }),
    });

  function client(overrides: Partial<MondayClient> = {}): MondayClient {
    return {
      findItemByColumnValue: vi.fn().mockResolvedValue(null),
      createItem: vi.fn().mockResolvedValue({ id: 'item-new' }),
      changeColumnValues: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it('flags a gift before the oldest active fiscal year instead of creating a duplicate', async () => {
    const eventStore = fakeStore(row('2025-06-30T12:00:00.000Z')); // FY 2025
    const mondayClient = client();
    const message = fakeMessage();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processFunraiseQueueBatch([message], { eventStore, mondayClient, config: archivedConfig });

    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'needs_review', {
      error: expect.stringContaining('fiscal year 2025'),
    });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('creates a gift in the oldest active fiscal year (boundary)', async () => {
    const eventStore = fakeStore(row('2025-07-01T12:00:00.000Z')); // FY 2026
    const mondayClient = client();

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: archivedConfig });

    expect(mondayClient.createItem).toHaveBeenCalled();
    expect(eventStore.updateStatusByEntity).not.toHaveBeenCalledWith('transaction', 'txn-1', 'needs_review', expect.anything());
  });

  it('still adopts an old gift whose item is active — the check only runs when the lookup finds nothing', async () => {
    const eventStore = fakeStore(row('2024-01-15T12:00:00.000Z'));
    const mondayClient = client({ findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'item-active' }) });

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: archivedConfig });

    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(111, 'item-active', expect.any(Object));
    expect(mondayClient.createItem).not.toHaveBeenCalled();
  });

  it('still updates through a recorded item id regardless of the gift date', async () => {
    const eventStore = fakeStore(
      eventRow({
        matchedDonorItemId: '7',
        mondayItemId: 'item-existing',
        rawPayload: JSON.stringify({ amount: 100, donationDate: '2020-01-01T00:00:00.000Z' }),
      })
    );
    const mondayClient = client();

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: archivedConfig });

    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(111, 'item-existing', expect.any(Object));
  });

  it('creates when the date is unparseable, since the fiscal year cannot be judged', async () => {
    const eventStore = fakeStore(row('not a date'));
    const mondayClient = client();

    await processFunraiseQueueBatch([fakeMessage()], { eventStore, mondayClient, config: archivedConfig });

    expect(mondayClient.createItem).toHaveBeenCalled();
  });

  it('does nothing when oldestActiveFiscalYear is null', async () => {
    const eventStore = fakeStore(row('2019-01-01T00:00:00.000Z'));
    const mondayClient = client();

    await processFunraiseQueueBatch(
      [fakeMessage()],
      { eventStore, mondayClient, config: { ...archivedConfig, funraiseSync: { ...archivedConfig.funraiseSync, oldestActiveFiscalYear: null } } }
    );

    expect(mondayClient.createItem).toHaveBeenCalled();
  });
});

// Write switch (spec 2026-10-26). `consumeFunraiseBatch` picks real deps (write), proxied deps
// (dry-run, then ack) or a delayed retry per message; processFunraiseQueueBatch is unchanged.
describe('write switch', () => {
  const switchConfig = testConfig({ entityIdColumn: 'entity_col', recurringGiftLinkColumn: 'rg_link_col' });

  const gate = (mode: WriteMode, logLevel: 'normal' | 'debug' = 'normal'): BatchSkipContext => ({
    worker: 'funraise-sync',
    environment: 'production',
    mode,
    logLevel,
    piiKeys: ['name', 'email'],
  });

  function subscriptionStore(): SubscriptionStore {
    return {
      getByFunraiseId: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      getCursor: vi.fn().mockResolvedValue(0),
      setCursor: vi.fn(),
      claimCreate: vi.fn().mockResolvedValue(true),
      releaseCreate: vi.fn(),
    };
  }

  function funraise(): FunraiseClient {
    return {
      listSubscriptionsUpdatedAfter: vi.fn(),
      listSubscriptionsAtUpdtime: vi.fn(),
      getSubscription: vi.fn().mockResolvedValue({ id: 26, name: 'Sub 26', status: 'Active', frequency: 'Monthly', sourceAmount: 25, updtime: 5, supporter: { id: 9, name: 'Ada', email: 'a@b.org' } }),
    };
  }

  // Every lookup misses: no donor match, no orphan, no existing Recurring Gift — the full chain.
  function missingMonday(): MondayClient {
    return {
      findItemByColumnValue: vi.fn().mockResolvedValue(null),
      createItem: vi.fn().mockResolvedValue({ id: 'real-1' }),
      changeColumnValues: vi.fn(),
    };
  }

  const installment = JSON.stringify({ amount: 100, subscription: { id: 26 }, donor: { contactId: 'fr-1', email: 'a@b.org', name: 'Ada' } });

  function setup(rowOverrides: Partial<EventRow> = {}) {
    const eventStore = fakeStore(eventRow(rowOverrides));
    const subs = subscriptionStore();
    const mondayClient = missingMonday();
    const deps = { eventStore, mondayClient, config: switchConfig, subscriptionStore: subs, funraiseClient: funraise() };
    const mutatorCalls = () =>
      [eventStore.upsertEvent, eventStore.updateStatusByEntity, subs.upsert, subs.setCursor, subs.claimCreate, subs.releaseCreate]
        .reduce((total, fn) => total + (fn as ReturnType<typeof vi.fn>).mock.calls.length, 0);
    return { eventStore, subs, mondayClient, deps, mutatorCalls };
  }

  function skipLines(log: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
    return log.mock.calls
      .map((call: unknown[]) => call[0])
      .filter((line: unknown): line is string => typeof line === 'string' && line.includes('"writeSwitch":"skipped"'))
      .map((line: string) => JSON.parse(line) as Record<string, unknown>);
  }

  async function quietly<T>(fn: (log: ReturnType<typeof vi.spyOn>) => Promise<T>): Promise<T> {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      return await fn(log);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  }

  it('off: writes nothing to Monday or D1, logs the skipped Donations create, and acks', async () => {
    const { deps, mondayClient, mutatorCalls } = setup({ matchedDonorItemId: '7' });
    const message = fakeMessage();

    const lines = await quietly(async (log) => {
      await consumeFunraiseBatch([message], deps, gate('off'));
      return skipLines(log);
    });

    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(mutatorCalls()).toBe(0);
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(lines).toContainEqual(expect.objectContaining({
      writeSwitch: 'skipped', worker: 'funraise-sync', mode: 'off', sink: 'Donations', operation: 'createItem', deliveryId: 'transaction:txn-1',
    }));
  });

  it('off with no donor match (Review Focus 2): records the People create, persists no placeholder id, links the Donation to it', async () => {
    const { deps, eventStore, mondayClient } = setup();
    const message = fakeMessage();

    const lines = await quietly(async (log) => {
      await consumeFunraiseBatch([message], deps, gate('off', 'debug'));
      return skipLines(log);
    });

    expect(mondayClient.createItem).not.toHaveBeenCalled();
    // matched_donor_item_id is written only through updateStatusByEntity('matched'): never called.
    expect(eventStore.updateStatusByEntity).not.toHaveBeenCalled();
    const people = lines.find((l) => l.sink === 'People');
    const donation = lines.find((l) => l.sink === 'Donations');
    expect(people).toMatchObject({ operation: 'createItem' });
    expect(donation).toMatchObject({ operation: 'createItem' });
    // Debug payload: [boardId, itemName (masked), columnValues]; the link carries the placeholder.
    const columnValues = (donation!.payload as unknown[])[2] as Record<string, unknown>;
    expect(columnValues.connect_col).toEqual({ item_ids: ['dry-run-1'] });
    expect(message.ack).toHaveBeenCalled();
  });

  it('off on an installment (Review Focus 3): the Recurring Gifts create still logs a skip line', async () => {
    const { deps, subs, mondayClient } = setup({ matchedDonorItemId: '7', rawPayload: installment });

    const lines = await quietly(async (log) => {
      await consumeFunraiseBatch([fakeMessage()], deps, gate('off'));
      return skipLines(log);
    });

    expect(lines).toContainEqual(expect.objectContaining({ sink: 'Recurring Gifts', operation: 'createItem' }));
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(subs.upsert).not.toHaveBeenCalled();
    expect(subs.claimCreate).not.toHaveBeenCalled();
  });

  it('on + a dropped stamp: dry-runs exactly as off does', async () => {
    const { deps, mondayClient, mutatorCalls } = setup({ matchedDonorItemId: '7' });
    const message = { ...fakeMessage(), body: { entityType: 'transaction' as const, entityId: 'txn-1', writeStamp: 'dropped' as const } };

    const lines = await quietly(async (log) => {
      await consumeFunraiseBatch([message], deps, gate('on'));
      return skipLines(log);
    });

    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mutatorCalls()).toBe(0);
    expect(message.ack).toHaveBeenCalled();
    expect(lines).toContainEqual(expect.objectContaining({ sink: 'Donations', mode: 'on' }));
  });

  it.each(['hold', 'unknown'] as const)('%s: retries after 60 s on attempt 1 without processing', async (mode) => {
    const { deps, eventStore, mondayClient } = setup();
    const message = { ...fakeMessage(), attempts: 1 };

    await consumeFunraiseBatch([message], deps, gate(mode));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(eventStore.getEventByEntity).not.toHaveBeenCalled();
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
  });

  it('hold: backs off by attempt like any other retry', async () => {
    const { deps } = setup();
    const message = { ...fakeMessage(), attempts: 4 };

    await consumeFunraiseBatch([message], deps, gate('hold'));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 480 });
  });

  it('on + an unstamped message enqueued before the switch existed (Review Focus 1): writes', async () => {
    const { deps, eventStore, mondayClient } = setup({ matchedDonorItemId: '7' });
    // The pre-deploy body shape: no writeStamp key at all.
    const message = { body: { entityType: 'transaction', entityId: 'txn-1' } as FunraiseQueueMessage, ack: vi.fn(), retry: vi.fn() };

    await consumeFunraiseBatch([message], deps, gate('on'));

    expect(mondayClient.createItem).toHaveBeenCalledWith(111, expect.any(String), expect.objectContaining({ connect_col: { item_ids: [7] } }));
    expect(eventStore.updateStatusByEntity).toHaveBeenCalledWith('transaction', 'txn-1', 'written', expect.objectContaining({ mondayItemId: 'real-1' }));
    expect(message.ack).toHaveBeenCalled();
  });

  it('off: a failing read still retries with backoff, and records nothing', async () => {
    const { deps, mondayClient, mutatorCalls } = setup();
    (mondayClient.findItemByColumnValue as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday API: HTTP 503'));
    const message = { ...fakeMessage(), attempts: 2 };

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await consumeFunraiseBatch([message], deps, gate('off'));
    } finally {
      errors.mockRestore();
    }

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 });
    expect(mutatorCalls()).toBe(0);
  });
});
