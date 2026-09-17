import { describe, it, expect, vi } from 'vitest';
import { processRecomputeBatch, rollupToColumnValues } from './processBatch';
import type { PendingStore } from '../db/pending';
import type { DonationLinksStore } from '../db/links';
import type { GiftsStore } from '../db/gifts';
import type { DonationRollupsMondayClient, DonationRecord } from '../monday/client';
import type { DonationRollupsConfig, OwnerColumns } from '../types';
import type { MembershipBaselineStore, BaselineRow } from '../db/membershipBaseline';
import type { MembershipConfig } from '../types';

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

const membershipConfig: MembershipConfig = {
  fromISO: '2026-10-01', eligibleGiftTypes: ['Donation'], termMonths: 12, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', renewal: 'Renewal', reacquire: 'Reacquire', lifetime: 'Lifetime' },
};
const memberOwnerColumns: OwnerColumns = { ...ownerColumns, membership: { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil' } };
const membershipBoard = { boardId: 1, columns: { donorLink: 'donor_link_1', amount: 'amount_1', date: 'date_1', status: 'status_1',
  fiscalYear: 'fy_1', giftType: 'gt_1', termStart: 'ts_1', termEnd: 'te_1', membershipType: 'mty_1' } };
const membershipEnabled: DonationRollupsConfig = {
  ...config,
  donationRollups: {
    ...config.donationRollups,
    donationBoards: [membershipBoard],
    ownerColumnsByBoard: { '2': memberOwnerColumns, '3': ownerColumns },
    membership: membershipConfig,
  },
};

function fakeBaselineStore(existing: BaselineRow | null = null): MembershipBaselineStore & { captured: BaselineRow[] } {
  const captured: BaselineRow[] = [];
  return {
    captured,
    get: vi.fn().mockResolvedValue(existing),
    captureIfAbsent: vi.fn().mockImplementation(async (row: BaselineRow) => { captured.push(row); return existing ?? row; }),
  };
}

const NOW = new Date('2026-11-06T12:00:00Z');
const renewalGift = { id: 'dn1', amount: 50, dateISO: '2026-11-05', fiscalYear: 2027, status: 'Received',
  giftType: 'Donation', termStart: null, termEnd: null, membershipType: null };

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
    getOwnerMembership: vi.fn().mockResolvedValue({ statusLabel: null, tierLabel: null, since: null, until: null }),
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
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, baselineStore: fakeBaselineStore(), mondayClient, config, now: new Date('2026-01-01') });

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
      { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config, now: new Date('2026-01-01') });
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
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, baselineStore: fakeBaselineStore(), mondayClient, config, now: new Date('2026-01-01') });

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
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, baselineStore: fakeBaselineStore(), mondayClient, config: configWithAlert, now: new Date('2026-01-01') });

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
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, baselineStore: fakeBaselineStore(), mondayClient, config: configWithAlert, now: new Date('2026-01-01') });

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
      { pendingStore, linksStore: fakeLinksStore(), giftsStore, baselineStore: fakeBaselineStore(), mondayClient, config: configWithAlert, now: new Date('2026-01-01') });

    expect(message.ack).toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written', expect.anything());
  });

  it('does not alert for an ordinary-sized projection', async () => {
    const createUpdate = vi.fn().mockResolvedValue(undefined);
    const mondayClient = fakeMondayClient({ createUpdate });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config: configWithAlert, now: new Date('2026-01-01') });
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
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore({ upsertLink }), giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config, now: new Date('2026-01-01') });
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
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore({ getLinksForOwner }), giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config, now: new Date('2026-01-01') });
    expect(getDonationsByIds).toHaveBeenCalledTimes(2); // both boards the index has links on
    expect(getDonationsByIds).toHaveBeenCalledWith(['dn1', 'dnOld'], expect.objectContaining({ fiscalYear: 'fy_1' }));
    expect(getDonationsByIds).toHaveBeenCalledWith(['dnHist'], expect.objectContaining({ fiscalYear: null }));
  });

  it('skips a configured board entirely when the index has no links there for this owner', async () => {
    const getDonationsByIds = vi.fn().mockResolvedValue([]);
    const getLinksForOwner = vi.fn().mockResolvedValue(new Map([['1', ['dn1']]])); // nothing on board 9
    const mondayClient = fakeMondayClient({ getDonationsByIds });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore({ getLinksForOwner }), giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config, now: new Date('2026-01-01') });
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

    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore, linksStore, giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config, now: new Date('2026-01-01') });

    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(3, 'donor-1', expect.objectContaining({ lg: '100' }));
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written',
      expect.objectContaining({ ownerItemId: 'donor-1', ownerBoard: '3' }));
  });

  it('fails loudly (not a silent skip) when the owner lives on a board with no configured columns', async () => {
    const mondayClient = fakeMondayClient({ getItemBoardId: vi.fn().mockResolvedValue('999') }); // not in config
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn1');

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'failed', expect.objectContaining({
      error: expect.stringContaining('999'),
    }));
  });

  it('skips cleanly (no retry) when the donation has no linked owner on Monday or in D1', async () => {
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockResolvedValue(null) });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn3');

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config });

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

    await processRecomputeBatch([message], { pendingStore, linksStore, giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config, now: new Date('2026-01-01') });

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

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config });

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

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(), baselineStore: fakeBaselineStore(), mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn4', 'failed', { error: 'monday API: HTTP 500' });
  });
});

describe('membership step (spec 2026-09-15)', () => {
  function deps(over: {
    board?: { statusLabel: string | null; tierLabel: string | null; since: string | null; until: string | null };
    baseline?: BaselineRow | null;
    donations?: unknown[];
    ownerBoard?: string;
    cfg?: DonationRollupsConfig;
  } = {}) {
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const baselineStore = fakeBaselineStore(over.baseline ?? null);
    const mondayClient = fakeMondayClient({
      changeColumnValues,
      getItemBoardId: vi.fn().mockResolvedValue(over.ownerBoard ?? '2'),
      getDonationsByIds: vi.fn().mockResolvedValue(over.donations ?? [renewalGift]),
      getOwnerMembership: vi.fn().mockResolvedValue(over.board ?? { statusLabel: null, tierLabel: null, since: null, until: null }),
    });
    return {
      changeColumnValues, baselineStore, mondayClient,
      run: () => processRecomputeBatch([fakeMessage('dn1')], {
        pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(),
        baselineStore, mondayClient, config: over.cfg ?? membershipEnabled, now: NOW,
      }),
    };
  }

  it('a lapsed migrated member renewing: captures the baseline once, writes Status+Until on the owner, stamps the gift', async () => {
    const d = deps({ board: { statusLabel: 'Lapsed', tierLabel: 'Member', since: '2015-01-01', until: '2026-03-01' } });
    await d.run();
    expect(d.baselineStore.captured).toEqual([expect.objectContaining({ ownerItemId: 'donor-1', ownerBoardId: '2',
      since: '2015-01-01', until: '2026-03-01', tier: 'member' })]);
    const [ownerCall, giftCall] = d.changeColumnValues.mock.calls;
    expect(ownerCall![0]).toBe(2); expect(ownerCall![1]).toBe('donor-1');
    expect(ownerCall![2]).toMatchObject({ ms: { label: 'Active' }, muntil: { date: '2027-11-05' } });
    expect(ownerCall![2]).not.toHaveProperty('msince');
    expect(ownerCall![2]).not.toHaveProperty('mt');
    expect(giftCall).toEqual([1, 'dn1', { ts_1: { date: '2026-11-05' }, te_1: { date: '2027-11-05' }, mty_1: 'Reacquire' }]);
  });

  it('uses the stored baseline, not the board, for the term type on a re-run', async () => {
    // Board already reflects the first run (Active, Until 2027-11-05); baseline says lapsed → still Reacquire.
    const baseline: BaselineRow = { ownerItemId: 'donor-1', ownerBoardId: '2', since: '2015-01-01', until: '2026-03-01', tier: 'member', capturedAt: 'x' };
    const d = deps({ baseline, board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2027-11-05' },
      donations: [{ ...renewalGift, termStart: '2026-11-05', termEnd: '2027-11-05', membershipType: 'Reacquire' }] });
    await d.run();
    expect(d.baselineStore.captureIfAbsent).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1); // rollups only — no membership keys, no gift write
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('ms');
  });

  it('a never-member: writes all four owner columns and a New term', async () => {
    const d = deps();
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({
      ms: { label: 'Active' }, mt: { label: 'Member' }, msince: { date: '2026-11-05' }, muntil: { date: '2027-11-05' } });
    expect(d.changeColumnValues.mock.calls[1]![2]).toMatchObject({ mty_1: 'New' });
  });

  it('a $1,000 gift makes the owner Lifetime with Until cleared and a blank Term End', async () => {
    const d = deps({ board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2027-04-11' },
      donations: [{ ...renewalGift, amount: 1000 }] });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ mt: { label: 'Lifetime' }, muntil: null });
    expect(d.changeColumnValues.mock.calls[1]![2]).toEqual({ ts_1: { date: '2026-11-05' }, mty_1: 'Lifetime' });
  });

  it('a staff-extended Until on the board is kept (extend-only merge)', async () => {
    const d = deps({ board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2029-01-01' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('muntil');
    expect(d.changeColumnValues.mock.calls[1]![2]).toMatchObject({ mty_1: 'Renewal', te_1: { date: '2027-11-05' } });
  });

  it('extend-only merge against a stale baseline: a later board Until survives, and the term type still comes from the baseline', async () => {
    // Baseline says this owner lapsed 2026-03-01; staff have since hand-extended the board to 2029-01-01.
    const baseline: BaselineRow = { ownerItemId: 'donor-1', ownerBoardId: '2', since: '2015-01-01', until: '2026-03-01', tier: 'member', capturedAt: 'x' };
    const d = deps({ baseline, board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2029-01-01' } });
    await d.run();
    // Derived Until would be 2027-11-05; the board's 2029-01-01 is later and must be kept, so no Until write.
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('muntil');
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('ms');
    // Type is derived from the baseline (lapsed before the gift), not from the board (active).
    expect(d.changeColumnValues.mock.calls[1]![2]).toMatchObject({ mty_1: 'Reacquire', te_1: { date: '2027-11-05' } });
  });

  it('an Organizations owner (no membership columns) gets no membership writes and no baseline', async () => {
    const d = deps({ ownerBoard: '3' });
    await d.run();
    expect(d.baselineStore.captureIfAbsent).not.toHaveBeenCalled();
    expect(d.mondayClient.getOwnerMembership).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('with the membership block null the step is skipped entirely', async () => {
    const d = deps({ cfg: { ...membershipEnabled, donationRollups: { ...membershipEnabled.donationRollups, membership: null } } });
    await d.run();
    expect(d.mondayClient.getOwnerMembership).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('ineligible gifts (pre-cutover, non-Donation, not Received) neither write the owner nor stamp the gift', async () => {
    const d = deps({ donations: [
      { ...renewalGift, id: 'old', dateISO: '2026-09-30' },
      { ...renewalGift, id: 'match', giftType: 'Matching Donation' },
      { ...renewalGift, id: 'pending', status: 'Pending' },
    ] });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('ms');
  });

  it('an owner with no eligible gifts: baseline is captured but nothing membership-related is written, even when the board is stale', async () => {
    // Lifetime owner whose board still carries a Member Until (staff edit) and a Lapsed status:
    // with no eligible gift there is nothing to do — the merge must not clear Until or flip Status.
    const d = deps({ board: { statusLabel: 'Lapsed', tierLabel: 'Lifetime', since: '2015-01-01', until: '2027-01-01' },
      donations: [{ ...renewalGift, dateISO: '2026-09-30' }] });
    await d.run();
    expect(d.baselineStore.captureIfAbsent).toHaveBeenCalledTimes(1);
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
    for (const key of ['ms', 'mt', 'msince', 'muntil']) expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty(key);
  });

  it('caps gift term stamps per recompute and continues on later recomputes', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...renewalGift, id: `g${String(i).padStart(2, '0')}`,
      dateISO: `2026-11-${String(i + 1).padStart(2, '0')}` }));
    const d = deps({ donations: many });
    await d.run();
    // 1 owner write + 10 gift writes, oldest gifts first
    expect(d.changeColumnValues).toHaveBeenCalledTimes(11);
    expect(d.changeColumnValues.mock.calls.slice(1).map((c) => c[1])).toEqual(many.slice(0, 10).map((g) => g.id));
  });

  it('the owner write precedes the gift writes, and a failing gift write still retries the message', async () => {
    const d = deps();
    d.changeColumnValues.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('monday API: HTTP 500'));
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message], {
      pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(),
      baselineStore: d.baselineStore, mondayClient: d.mondayClient, config: membershipEnabled, now: NOW,
    });
    expect(d.changeColumnValues.mock.calls[0]![1]).toBe('donor-1');
    expect(message.retry).toHaveBeenCalled();
  });
});
