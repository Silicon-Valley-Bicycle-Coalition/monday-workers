import { describe, it, expect, vi } from 'vitest';
import { processRecomputeBatch, rollupToColumnValues } from './processBatch';
import type { PendingStore } from '../db/pending';
import type { DonationLinksStore } from '../db/links';
import type { GiftsStore } from '../db/gifts';
import type { DonationRollupsMondayClient, DonationRecord } from '../monday/client';
import type { DonationRollupsConfig, OwnerColumns } from '../types';

const ownerColumns: OwnerColumns = {
  giftLedgerJson: 'glj', lifetimeGiving: 'lg', giftCount: 'gc', firstGift: 'fg',
  thisYearAmount: 'tya', thisYearCount: 'tyc', lastYearAmount: 'lya', lastYearCount: 'lyc',
  largestGift: 'lag', smallestGift: 'smg', averageGift: 'avg',
  lastGiftDate: 'lgd', lastGiftAmount: 'lga',
};

const config: DonationRollupsConfig = {
  monday: { apiUrl: 'https://api.monday.com/v2', accountUrl: 'https://acme.monday.com' },
  custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
    annualSummaryBoardId: null, annualSummaryColumns: null },
  donationRollups: {
    donationBoards: [
      { boardId: 1, columns: { donorLink: 'donor_link_1', amount: 'amount_1', date: 'date_1', status: 'status_1', fiscalYear: 'fy_1' } },
      { boardId: 9, columns: { donorLink: 'donor_link_9', amount: 'amount_9', date: 'date_9', status: 'status_9', fiscalYear: null } },
    ],
    receivedStatusLabel: 'Received',
    ownerColumnsByBoard: { '2': ownerColumns, '3': ownerColumns },
    membership: null,
  },
};

function fakePendingStore(overrides: Partial<PendingStore> = {}): PendingStore {
  return {
    upsertPending: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// Default: this donation is the *only* link on record — both board-1 and board-9
// groups are exercised in tests that need more than one.
function fakeLinksStore(overrides: Partial<DonationLinksStore> = {}): DonationLinksStore {
  return {
    upsertLink: vi.fn().mockResolvedValue(undefined),
    getLinksForOwner: vi.fn().mockResolvedValue(new Map([['1', ['dn1']]])),
    getLinkForDonation: vi.fn().mockResolvedValue(null),
    bulkUpsert: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function fakeGiftsStore(): GiftsStore {
  return {
    refreshFacts: vi.fn().mockResolvedValue(undefined),
    giftsForOwner: vi.fn().mockResolvedValue([]),
    setSummaryItemId: vi.fn().mockResolvedValue(undefined),
    getArchivable: vi.fn().mockResolvedValue([]),
    markArchived: vi.fn().mockResolvedValue(undefined),
    ownersWithOneGift: vi.fn().mockResolvedValue([]),
    ownerTotals: vi.fn().mockResolvedValue(new Map()),
    fiscalYearTotals: vi.fn().mockResolvedValue([]),
    upsertAnnualSummaries: vi.fn().mockResolvedValue({ changed: [] }),
    getAnnualSummaries: vi.fn().mockResolvedValue([]),
    recordRun: vi.fn().mockResolvedValue(undefined),
    lastRuns: vi.fn().mockResolvedValue([]),
  };
}

function fakeMessage(donationItemId: string, donationBoardId = '1') {
  return { body: { donationItemId, donationBoardId }, ack: vi.fn(), retry: vi.fn() };
}

function fakeMondayClient(overrides: Partial<DonationRollupsMondayClient> = {}): DonationRollupsMondayClient {
  return {
    getItemBoardId: vi.fn().mockResolvedValue('2'),
    getDonorLinkForDonation: vi.fn().mockResolvedValue('donor-1'),
    getDonationsByIds: vi.fn().mockResolvedValue([]),
    listDonationOwnerLinks: vi.fn().mockResolvedValue([]),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    setItemDescription: vi.fn().mockResolvedValue(undefined),
    createUpdate: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// Enough ledger rows that the JSON projection blows past the ~60KB write budget.
const oversizedHistory = Array.from({ length: 2_000 }, (_, i) => ({
  mondayItemId: `18427756${String(i).padStart(6, '0')}`, donationBoardId: '1',
  amountCents: 5000, giftDateISO: `${2000 + (i % 26)}-01-15`, fiscalYear: 2000 + (i % 26),
  status: 'Received', giftType: 'Donation', archived: false,
}));

const configWithAlert: DonationRollupsConfig = {
  ...config,
  custodian: { ...config.custodian, alertItemId: 42 },
};

describe('gift-history projections in the recompute path', () => {
  it('writes the JSON column with the rollups and the markdown description, from the ledger', async () => {
    const giftsStore = fakeGiftsStore();
    (giftsStore.giftsForOwner as ReturnType<typeof vi.fn>).mockResolvedValue([
      { mondayItemId: 'dn1', donationBoardId: '1', amountCents: 5000, giftDateISO: '2020-01-15',
        fiscalYear: 2020, status: 'Received', giftType: 'Donation', archived: true },
    ]);
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const setItemDescription = vi.fn().mockResolvedValue(undefined);
    const mondayClient = fakeMondayClient({
      changeColumnValues, setItemDescription,
      getDonationsByIds: vi.fn().mockResolvedValue([
        { id: 'dn1', amount: 50, dateISO: '2020-01-15', fiscalYear: 2020, status: 'Received' },
      ]),
    });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, mondayClient, config, now: new Date('2026-01-01') });

    const written = changeColumnValues.mock.calls[0]![2] as Record<string, unknown>;
    expect(JSON.parse(written['glj'] as string)).toEqual([['dn1', '2020-01-15', 5000, 'Donation', 'Received']]);
    expect(setItemDescription).toHaveBeenCalledWith('donor-1',
      expect.stringContaining('https://acme.monday.com/boards/1/pulses/dn1'));
    expect(giftsStore.refreshFacts).toHaveBeenCalledWith(
      [expect.objectContaining({ mondayItemId: 'dn1', giftType: null })], 'webhook', expect.any(String));
  });

  it('a failing description write is non-fatal — rollups land and the message still acks', async () => {
    const pendingStore = fakePendingStore();
    const setItemDescription = vi.fn().mockRejectedValue(new Error('monday API: Internal server error'));
    const mondayClient = fakeMondayClient({
      setItemDescription,
      getDonationsByIds: vi.fn().mockResolvedValue([
        { id: 'dn1', amount: 50, dateISO: '2020-01-15', fiscalYear: 2020, status: 'Received' },
      ]),
    });
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message],
      { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), mondayClient, config, now: new Date('2026-01-01') });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written', expect.anything());
  });
});

describe('oversized gift-ledger projections (docs/20 §5.5 overflow)', () => {
  function oversizedSetup(overrides: Partial<DonationRollupsMondayClient> = {}) {
    const giftsStore = fakeGiftsStore();
    (giftsStore.giftsForOwner as ReturnType<typeof vi.fn>).mockResolvedValue(oversizedHistory);
    const mondayClient = fakeMondayClient({
      getDonationsByIds: vi.fn().mockResolvedValue([
        { id: 'dn1', amount: 50, dateISO: '2020-01-15', fiscalYear: 2020, status: 'Received' },
      ]),
      ...overrides,
    });
    return { giftsStore, mondayClient };
  }

  it('truncates the projection instead of letting an over-budget JSON kill the rollup write', async () => {
    const { giftsStore, mondayClient } = oversizedSetup();
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, mondayClient, config, now: new Date('2026-01-01') });

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    const written = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>;
    const json = written['glj'] as string;
    expect(json.length).toBeLessThanOrEqual(60_000);
    const tuples = JSON.parse(json) as unknown[][];
    expect(tuples.length).toBeLessThan(oversizedHistory.length);
    expect(tuples.at(-1)![0]).toBe('~truncated'); // marker entry, full count noted
    expect(tuples.at(-1)![4]).toContain('2000');
  });

  it('alerts through the custodian path (Monday update on alertItemId) with owner id and byte size', async () => {
    const createUpdate = vi.fn().mockResolvedValue(undefined);
    const { giftsStore, mondayClient } = oversizedSetup({ createUpdate });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, mondayClient, config: configWithAlert, now: new Date('2026-01-01') });

    expect(createUpdate).toHaveBeenCalledTimes(1);
    const [itemId, body] = createUpdate.mock.calls[0]! as [number, string];
    expect(itemId).toBe(42);
    expect(body).toContain('donor-1'); // the owner whose projection overflowed
    expect(body).toMatch(/\d{5,} bytes/); // the actual size, for the planning decision
  });

  it('alerts (without truncating) already at the 48KB planning threshold', async () => {
    const createUpdate = vi.fn().mockResolvedValue(undefined);
    const giftsStore = fakeGiftsStore();
    (giftsStore.giftsForOwner as ReturnType<typeof vi.fn>).mockResolvedValue(oversizedHistory.slice(0, 1_000)); // ~50KB
    const mondayClient = fakeMondayClient({ createUpdate });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, mondayClient, config: configWithAlert, now: new Date('2026-01-01') });

    expect(createUpdate).toHaveBeenCalledTimes(1);
    const written = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>;
    expect(JSON.parse(written['glj'] as string)).toHaveLength(1_000); // still the full projection
  });

  it('a failing alert post never kills the rollup write', async () => {
    const { giftsStore, mondayClient } = oversizedSetup({
      createUpdate: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
    });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message],
      { pendingStore, linksStore: fakeLinksStore(), giftsStore, mondayClient, config: configWithAlert, now: new Date('2026-01-01') });

    expect(message.ack).toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written', expect.anything());
  });

  it('does not alert for an ordinary-sized projection', async () => {
    const createUpdate = vi.fn().mockResolvedValue(undefined);
    const mondayClient = fakeMondayClient({ createUpdate });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), mondayClient, config: configWithAlert, now: new Date('2026-01-01') });
    expect(createUpdate).not.toHaveBeenCalled();
  });
});

describe('rollupToColumnValues', () => {
  it('maps every rollup field to its configured column id, nulls stay null', () => {
    const values = rollupToColumnValues({
      lifetimeGiving: 100, giftCount: 2, firstGiftISO: '2020-01-01',
      thisYearAmount: 50, thisYearCount: 1, lastYearAmount: 50, lastYearCount: 1,
      largestGift: 75, smallestGift: 25, averageGift: 50,
      lastGiftDate: '2024-01-01', lastGiftAmount: 75,
    }, ownerColumns);
    expect(values.lg).toBe('100');
    expect(values.fg).toEqual({ date: '2020-01-01' });
    expect(values.avg).toBe('50');
  });

  it('writes empty string / null for a donor with no received gifts, not "null" text', () => {
    const values = rollupToColumnValues({
      lifetimeGiving: 0, giftCount: 0, firstGiftISO: null,
      thisYearAmount: 0, thisYearCount: 0, lastYearAmount: 0, lastYearCount: 0,
      largestGift: null, smallestGift: null, averageGift: null,
      lastGiftDate: null, lastGiftAmount: null,
    }, ownerColumns);
    expect(values.lag).toBe('');
    expect(values.fg).toBeNull();
  });
});

describe('processRecomputeBatch', () => {
  it('resolves the donor link using the *source* board\'s own column ids, and records it in the reverse index', async () => {
    const getDonorLinkForDonation = vi.fn().mockResolvedValue('donor-1');
    const upsertLink = vi.fn().mockResolvedValue(undefined);
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation, getItemBoardId: vi.fn().mockResolvedValue('2') });
    await processRecomputeBatch([fakeMessage('dn1', '9')], // board 9, not board 1
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore({ upsertLink }), giftsStore: fakeGiftsStore(), mondayClient, config, now: new Date('2026-01-01') });
    expect(getDonorLinkForDonation).toHaveBeenCalledWith('dn1', 'donor_link_9'); // board 9's own column id
    expect(upsertLink).toHaveBeenCalledWith(
      { donationItemId: 'dn1', donationBoardId: '9', ownerItemId: 'donor-1', ownerBoardId: '2' },
      expect.any(String),
    );
  });

  it('fetches every donation the reverse index knows about for this owner, grouped by board', async () => {
    const getDonationsByIds = vi.fn().mockResolvedValue([]);
    const getLinksForOwner = vi.fn().mockResolvedValue(new Map([['1', ['dn1', 'dnOld']], ['9', ['dnHist']]]));
    const mondayClient = fakeMondayClient({ getDonationsByIds });
    await processRecomputeBatch([fakeMessage('dn1', '1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore({ getLinksForOwner }), giftsStore: fakeGiftsStore(), mondayClient, config, now: new Date('2026-01-01') });
    expect(getDonationsByIds).toHaveBeenCalledTimes(2); // both boards the index has links on
    expect(getDonationsByIds).toHaveBeenCalledWith(['dn1', 'dnOld'], expect.objectContaining({ fiscalYear: 'fy_1' }));
    expect(getDonationsByIds).toHaveBeenCalledWith(['dnHist'], expect.objectContaining({ fiscalYear: null }));
  });

  it('skips a configured board entirely when the index has no links there for this owner', async () => {
    const getDonationsByIds = vi.fn().mockResolvedValue([]);
    const getLinksForOwner = vi.fn().mockResolvedValue(new Map([['1', ['dn1']]])); // nothing on board 9
    const mondayClient = fakeMondayClient({ getDonationsByIds });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore({ getLinksForOwner }), giftsStore: fakeGiftsStore(), mondayClient, config, now: new Date('2026-01-01') });
    expect(getDonationsByIds).toHaveBeenCalledTimes(1);
  });

  it('writes to whichever board the owner item actually lives on, keyed by real board id', async () => {
    const donations: DonationRecord[] = [
      { id: 'd1', amount: 100, dateISO: '2025-08-01', fiscalYear: 2026, status: 'Received' },
    ];
    const mondayClient = fakeMondayClient({
      getItemBoardId: vi.fn().mockResolvedValue('3'), // matches the second configured owner board
      getDonationsByIds: vi.fn().mockResolvedValue(donations),
    });
    const linksStore = fakeLinksStore({ getLinksForOwner: vi.fn().mockResolvedValue(new Map([['1', ['dn1']]])) });
    const pendingStore = fakePendingStore();

    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore, linksStore, giftsStore: fakeGiftsStore(), mondayClient, config, now: new Date('2026-01-01') });

    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(3, 'donor-1', expect.objectContaining({ lg: '100' }));
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written',
      expect.objectContaining({ ownerItemId: 'donor-1', ownerBoard: '3' }));
  });

  it('fails loudly (not a silent skip) when the owner lives on a board with no configured columns', async () => {
    const mondayClient = fakeMondayClient({ getItemBoardId: vi.fn().mockResolvedValue('999') }); // not in config
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn1');

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'failed', expect.objectContaining({
      error: expect.stringContaining('999'),
    }));
  });

  it('skips cleanly (no retry) when the donation has no linked owner on Monday or in D1', async () => {
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockResolvedValue(null) });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn3');

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), mondayClient, config });

    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn3', 'written', expect.anything());
  });

  it('recomputes via the D1-known owner when the Monday link reads back empty (archived representative gift)', async () => {
    // The July sweep's representative gift is often the owner's oldest, archived gift —
    // its board_relation reads back empty, but donation_links still knows the owner.
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockResolvedValue(null) });
    const linksStore = fakeLinksStore({
      getLinkForDonation: vi.fn().mockResolvedValue({ ownerItemId: 'donor-1', ownerBoardId: '2' }),
    });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dnArchived');

    await processRecomputeBatch([message], { pendingStore, linksStore, giftsStore: fakeGiftsStore(), mondayClient, config, now: new Date('2026-01-01') });

    expect(linksStore.getLinkForDonation).toHaveBeenCalledWith('dnArchived');
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'donor-1', expect.anything());
    expect(message.ack).toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dnArchived', 'written',
      expect.objectContaining({ ownerItemId: 'donor-1' }));
  });

  it('acks (not retries) a donation from a board missing from config — a config mismatch never heals by retrying', async () => {
    const mondayClient = fakeMondayClient();
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn5', '77'); // no donationBoards entry for board 77

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), mondayClient, config });

    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn5', 'failed', expect.objectContaining({
      error: expect.stringContaining('77'),
    }));
  });

  it('retries and marks failed on a Monday API error, does not ack', async () => {
    const mondayClient = fakeMondayClient({
      changeColumnValues: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
    });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn4');

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn4', 'failed', { error: 'monday API: HTTP 500' });
  });
});
