import { env } from 'cloudflare:workers';
import { describe, it, expect, vi } from 'vitest';
import { upsertSubscription } from './upsert';
import { D1SubscriptionStore, type SubscriptionStore, type SubscriptionRow } from '../db/subscriptions';
import type { MondayClient } from '../monday/client';
import type { FunraiseSubscription } from '../funraise/client';
import { testConfig } from '../test/testConfig';

const config = testConfig({ donorExternalIdField: 'supporter.id', emailFieldPrecedence: ['supporter.email'], donorNameField: 'supporter.name' });

const row: FunraiseSubscription = {
  id: 257753,
  name: 'Debbie Donor - Monthly',
  status: 'Active',
  frequency: 'Monthly',
  sourceAmount: 25,
  nextPaymentDate: 1791000000000,
  updtime: 1789000000000,
  companyMatch: { companyName: null },
  form: { name: 'General Donations' },
  supporter: { id: 7276, name: 'Debbie Donor', email: 'debbie@example.com' },
};

function fakeStore(existing: SubscriptionRow | null = null): SubscriptionStore {
  return {
    getByFunraiseId: vi.fn().mockResolvedValue(existing),
    upsert: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockResolvedValue(0),
    getCursor: vi.fn().mockResolvedValue(0),
    setCursor: vi.fn().mockResolvedValue(undefined),
    claimCreate: vi.fn().mockResolvedValue(true),
    releaseCreate: vi.fn().mockResolvedValue(undefined),
  };
}

// findItemByColumnValue is asked two different questions: the donor lookup on the People board
// (42) and the adopt-before-create lookup on the Recurring Gifts board (222).
function fakeMonday(answers: { donor?: string | null; adopt?: string | null } = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockImplementation(async (boardId: number) => {
      if (boardId === 42) return answers.donor ? { id: answers.donor } : null;
      if (boardId === 222) return answers.adopt ? { id: answers.adopt } : null;
      return null;
    }),
    createItem: vi.fn().mockResolvedValue({ id: 'rg-new' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
  };
}

describe('upsertSubscription', () => {
  it('creates a Recurring Gifts item with the mapped columns and the matched donor when nothing exists', async () => {
    const store = fakeStore(null);
    const monday = fakeMonday({ donor: '9001', adopt: null });

    const result = await upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config });

    expect(result).toEqual({ mondayItemId: 'rg-new', action: 'created' });
    expect(monday.findItemByColumnValue).toHaveBeenCalledWith(222, 'rg_funraise_id', '257753');
    expect(monday.createItem).toHaveBeenCalledWith(
      222,
      'Debbie Donor - Monthly',
      expect.objectContaining({
        rg_funraise_id: { url: 'https://platform.funraise.io/transaction/257753', text: '257753' },
        rg_installment: 25,
        rg_status: { label: 'Active' },
        rg_donor: { item_ids: [9001] },
      })
    );
    expect(store.upsert).toHaveBeenCalledWith({
      funraiseId: '257753',
      mondayItemId: 'rg-new',
      donorItemId: '9001',
      status: 'Active',
      updtime: 1789000000000,
    });
  });

  it('adopts an item the importer already created (found by bare Funraise id) instead of creating a second one', async () => {
    const store = fakeStore(null);
    const monday = fakeMonday({ donor: '9001', adopt: 'rg-imported' });

    const result = await upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config });

    expect(result).toEqual({ mondayItemId: 'rg-imported', action: 'adopted' });
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(monday.changeColumnValues).toHaveBeenCalledWith(222, 'rg-imported', expect.objectContaining({ rg_status: { label: 'Active' } }));
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({ mondayItemId: 'rg-imported', updtime: 1789000000000 }));
  });

  it('is a no-op when the ledger already holds this updtime', async () => {
    const store = fakeStore({ funraiseId: '257753', mondayItemId: 'rg-1', donorItemId: '9001', status: 'Active', updtime: 1789000000000, writtenAt: 'x' });
    const monday = fakeMonday();

    const result = await upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config });

    expect(result).toEqual({ mondayItemId: 'rg-1', action: 'noop' });
    expect(monday.findItemByColumnValue).not.toHaveBeenCalled();
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('updates the stored item in place when the row is newer than the ledger, or the ledger has no updtime (adopted)', async () => {
    for (const stored of [1788000000000, null]) {
      const store = fakeStore({ funraiseId: '257753', mondayItemId: 'rg-1', donorItemId: '9001', status: 'Active', updtime: stored, writtenAt: 'x' });
      const monday = fakeMonday({ donor: '9001' });

      const result = await upsertSubscription({ ...row, status: 'Cancelled', nextPaymentDate: null }, { subscriptionStore: store, mondayClient: monday, config });

      expect(result).toEqual({ mondayItemId: 'rg-1', action: 'updated' });
      expect(monday.changeColumnValues).toHaveBeenCalledWith(
        222,
        'rg-1',
        expect.objectContaining({ rg_status: { label: 'Cancelled' }, rg_next_payment: {} })
      );
      expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'Cancelled', updtime: 1789000000000 }));
    }
  });

  it('reuses the ledger donor instead of re-matching on an update (#94)', async () => {
    const store = fakeStore({ funraiseId: '257753', mondayItemId: 'rg-1', donorItemId: '9001', status: 'Active', updtime: 1, writtenAt: 'x' });
    const monday = fakeMonday();

    await upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config });

    expect(monday.findItemByColumnValue).not.toHaveBeenCalled();
    expect(monday.changeColumnValues).toHaveBeenCalledWith(222, 'rg-1', expect.objectContaining({ rg_donor: { item_ids: [9001] } }));
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({ donorItemId: '9001' }));
  });

  it('is a no-op when the row is older than the ledger — a stale page re-read never regresses the board', async () => {
    const store = fakeStore({ funraiseId: '257753', mondayItemId: 'rg-1', donorItemId: '9001', status: 'Cancelled', updtime: 1790000000000, writtenAt: 'x' });
    const monday = fakeMonday();

    const result = await upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config });

    expect(result).toEqual({ mondayItemId: 'rg-1', action: 'noop' });
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
  });

  it('creates the donor on the People board when no match exists, then links it', async () => {
    const store = fakeStore(null);
    const monday = fakeMonday({ donor: null, adopt: null });
    (monday.createItem as ReturnType<typeof vi.fn>).mockImplementation(async (boardId: number) =>
      boardId === 42 ? { id: '9002' } : { id: 'rg-new' }
    );

    await upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config });

    expect(monday.createItem).toHaveBeenCalledWith(42, 'Debbie Donor', expect.any(Object));
    expect(monday.createItem).toHaveBeenCalledWith(222, expect.any(String), expect.objectContaining({ rg_donor: { item_ids: [9002] } }));
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({ donorItemId: '9002' }));
  });

  it('still writes the item without a Donor link when the row has no supporter, recording a null donor', async () => {
    const store = fakeStore(null);
    const monday = fakeMonday({ adopt: null });

    await upsertSubscription({ ...row, supporter: null }, { subscriptionStore: store, mondayClient: monday, config });

    expect(monday.createItem).toHaveBeenCalledWith(222, expect.any(String), expect.not.objectContaining({ rg_donor: expect.anything() }));
    expect(store.upsert).toHaveBeenCalledWith(expect.objectContaining({ donorItemId: null }));
  });

  it('logs mapper warnings with the subscription id but still writes the row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const store = fakeStore(null);
      const monday = fakeMonday({ donor: '9001', adopt: null });

      await upsertSubscription({ ...row, frequency: 'Weekly' }, { subscriptionStore: store, mondayClient: monday, config });

      expect(monday.createItem).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('257753'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('frequency "Weekly"'));
    } finally {
      warn.mockRestore();
    }
  });

  it('throws when the Recurring Gifts board is not configured', async () => {
    const unconfigured = testConfig({}, { 'recurring-gifts': null });
    await expect(
      upsertSubscription(row, { subscriptionStore: fakeStore(null), mondayClient: fakeMonday(), config: unconfigured })
    ).rejects.toThrow(/recurring-gifts.*not configured/);
  });
});

// #25: the hourly poll and the queue consumer could both miss the ledger for one subscription,
// both find nothing on the board, and both create a Recurring Gifts item.
describe('upsertSubscription create claim', () => {
  it('claims before any Monday call on a ledger miss and releases after recording', async () => {
    const store = fakeStore(null);
    const monday = fakeMonday({ donor: '9001', adopt: null });

    await upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config });

    const claimOrder = (store.claimCreate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const firstMonday = (monday.findItemByColumnValue as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(claimOrder).toBeLessThan(firstMonday);
    const [claimedId, token] = (store.claimCreate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(claimedId).toBe('257753');
    expect(store.releaseCreate).toHaveBeenCalledWith('257753', token);
    const recordOrder = (store.upsert as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(recordOrder).toBeLessThan((store.releaseCreate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!);
  });

  it('throws without touching Monday when another writer holds the claim', async () => {
    const store = fakeStore(null);
    (store.claimCreate as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const monday = fakeMonday({ donor: '9001' });

    await expect(upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config })).rejects.toThrow(/another writer/);

    expect(monday.findItemByColumnValue).not.toHaveBeenCalled();
    expect(monday.createItem).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it('updates the item the other writer just recorded instead of creating a second one', async () => {
    const store = fakeStore(null);
    (store.getByFunraiseId as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ funraiseId: '257753', mondayItemId: 'rg-theirs', donorItemId: null, status: 'Active', updtime: null, writtenAt: 'x' });
    const monday = fakeMonday({ donor: '9001' });

    const result = await upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config });

    expect(result).toEqual({ mondayItemId: 'rg-theirs', action: 'updated' });
    expect(monday.createItem).not.toHaveBeenCalled();
  });

  it('keeps the claim when the write fails midway, so it expires rather than inviting a duplicate', async () => {
    const store = fakeStore(null);
    const monday = fakeMonday({ donor: '9001' });
    (monday.createItem as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('monday 500'));

    await expect(upsertSubscription(row, { subscriptionStore: store, mondayClient: monday, config })).rejects.toThrow(/monday 500/);

    expect(store.releaseCreate).not.toHaveBeenCalled();
  });

  it('never claims on a ledger hit', async () => {
    const store = fakeStore({ funraiseId: '257753', mondayItemId: 'rg-1', donorItemId: null, status: 'Active', updtime: 1, writtenAt: 'x' });
    await upsertSubscription(row, { subscriptionStore: store, mondayClient: fakeMonday({ donor: '9001' }), config });
    expect(store.claimCreate).not.toHaveBeenCalled();
  });

  it('creates exactly one item when the poll and the consumer race on the real D1 ledger', async () => {
    const store = new D1SubscriptionStore(env.DB);
    const monday = fakeMonday({ donor: '9001', adopt: null });
    const racer = { ...row, id: 197170 };

    const results = await Promise.allSettled([
      upsertSubscription(racer, { subscriptionStore: store, mondayClient: monday, config }),
      upsertSubscription(racer, { subscriptionStore: store, mondayClient: monday, config }),
    ]);

    expect(monday.createItem).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.getByFunraiseId('197170'))?.mondayItemId).toBe('rg-new');
  });
});
