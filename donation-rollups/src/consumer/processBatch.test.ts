import { describe, it, expect, vi } from 'vitest';
import { processRecomputeBatch, rollupToColumnValues, affectedAffiliations, type ProcessBatchDeps } from './processBatch';
import type { PendingStore } from '../db/pending';
import type { DonationLinksStore } from '../db/links';
import type { GiftsStore } from '../db/gifts';
import type { AffiliationsStore } from '../db/affiliations';
import type { DonationRollupsMondayClient, DonationRecord } from '../monday/client';
import { MondayRateLimitError } from '../monday/client';
import type { DonationRollupsConfig, OwnerColumns } from '../types';
import type { VolunteerActivityStore, VolunteerActivityRow } from '../db/volunteerActivity';
import type { GiftHistoryRow } from '../projections/giftHistory';
import type { BoardMembership } from '../membership/derive';
import type { OwnerRecomputesStore, OwnerRecompute } from '../db/ownerRecomputes';
import type { MembershipConfig } from '../types';

const ownerColumns: OwnerColumns = {
  giftLedgerJson: 'glj', lifetimeGiving: 'lg', giftCount: 'gc', firstGift: 'fg',
  thisYearAmount: 'tya', thisYearCount: 'tyc', lastYearAmount: 'lya', lastYearCount: 'lyc',
  largestGift: 'lag', smallestGift: 'smg', averageGift: 'avg',
  lastGiftDate: 'lgd', lastGiftAmount: 'lga',
};

const config: DonationRollupsConfig = {
  monday: { apiUrl: 'https://api.monday.com/v2', accountUrl: 'https://acme.monday.com' },
  fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
  custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
    annualSummaryBoardId: null, annualSummaryColumns: null },
  affiliations: null,
  donationRollups: {
    donationBoards: [
      { boardId: 1, columns: { donorLink: 'donor_link_1', amount: 'amount_1', date: 'date_1', status: 'status_1', fiscalYear: 'fy_1', actingForLink: null, classification: null } },
      { boardId: 9, columns: { donorLink: 'donor_link_9', amount: 'amount_9', date: 'date_9', status: 'status_9', fiscalYear: null, actingForLink: null, classification: null } },
    ],
    receivedStatusLabel: 'Received',
    ownerColumnsByBoard: { '2': ownerColumns, '3': ownerColumns },
    membership: null,
    donorLevel: null,
    volunteerBoards: [],
    historicalVolunteerBoards: [],
  },
};

const membershipConfig: MembershipConfig = {
  fromISO: '2026-10-16', eligibleGiftTypes: ['Donation'], minAmountCents: 100, termMonths: 13, lifetimeThresholdCents: 100000,
  statusLabels: { active: 'Active', lapsed: 'Lapsed' },
  tierLabels: { member: 'Member', lifetime: 'Lifetime' },
  typeLabels: { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' },
};
const memberOwnerColumns: OwnerColumns = { ...ownerColumns, membership: { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' } };
const membershipBoard = { boardId: 1, columns: { donorLink: 'donor_link_1', amount: 'amount_1', date: 'date_1', status: 'status_1',
  fiscalYear: 'fy_1', giftType: 'gt_1', termStart: 'ts_1', termEnd: 'te_1', membershipType: 'mty_1', actingForLink: null, classification: null } };
const membershipEnabled: DonationRollupsConfig = {
  ...config,
  donationRollups: {
    ...config.donationRollups,
    donationBoards: [membershipBoard],
    ownerColumnsByBoard: { '2': memberOwnerColumns, '3': ownerColumns },
    membership: membershipConfig,
    volunteerBoards: [],
    historicalVolunteerBoards: [],
  },
};

function fakeVolunteerStore(rows: VolunteerActivityRow[] = []): VolunteerActivityStore {
  return { upsert: vi.fn().mockResolvedValue({ previousOwner: null }), upsertMany: vi.fn().mockResolvedValue(undefined), forOwner: vi.fn().mockResolvedValue(rows),
    markRemoved: vi.fn().mockResolvedValue(null), ownersWithActivity: vi.fn().mockResolvedValue([]) };
}

const NOW = new Date('2026-11-06T12:00:00Z');
const renewalGift = { id: 'dn1', amountCents: 5000, dateISO: '2026-11-05', fiscalYear: 2027, status: 'Received',
  giftType: 'Donation', termStart: null, termEnd: null, membershipType: null };

function fakePendingStore(overrides: Partial<PendingStore> = {}): PendingStore {
  return {
    upsertPending: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockResolvedValue(null),
    listStuck: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// Default: this donation is the *only* link on record — both board-1 and board-9
// groups are exercised in tests that need more than one.
function fakeLinksStore(overrides: Partial<DonationLinksStore> = {}): DonationLinksStore {
  return {
    // Default: this link already existed unchanged since long before any recompute.
    upsertLink: vi.fn().mockResolvedValue({ changed: false, updatedAt: '2020-01-01T00:00:00Z' }),
    getLinksForOwner: vi.fn().mockResolvedValue(new Map([['1', ['dn1']]])),
    getLinkForDonation: vi.fn().mockResolvedValue(null),
    bulkUpsert: vi.fn().mockResolvedValue(0),
    deleteLink: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeRecomputesStore(last: OwnerRecompute | null = null): OwnerRecomputesStore {
  return { get: vi.fn().mockResolvedValue(last), record: vi.fn().mockResolvedValue(undefined), writtenSince: vi.fn().mockResolvedValue(new Set()) };
}

function fakeGiftsStore(): GiftsStore {
  return {
    refreshFacts: vi.fn().mockResolvedValue({ changed: 0 }),
    giftsForOwner: vi.fn().mockResolvedValue([]),
    markRemoved: vi.fn().mockResolvedValue(null),
    actingForByIds: vi.fn().mockResolvedValue(new Map()),
    attributedTotals: vi.fn().mockResolvedValue({ cents: 0, count: 0, lastGiftDateISO: null }),
    organizationalGivingTotals: vi.fn().mockResolvedValue({ cents: 0, count: 0 }),
    attributedTotalsAll: vi.fn().mockResolvedValue(new Map()),
    organizationalGivingAll: vi.fn().mockResolvedValue(new Map()),
    setSummaryItemId: vi.fn().mockResolvedValue(undefined),
    getArchivable: vi.fn().mockResolvedValue([]),
    markArchived: vi.fn().mockResolvedValue(undefined),
    giftsMissingTermStart: vi.fn().mockResolvedValue([]),
    setTermStarts: vi.fn().mockResolvedValue(undefined),
    ownersOnBoards: vi.fn().mockResolvedValue([]),
    ownersWithOneGift: vi.fn().mockResolvedValue([]),
    ownerTotals: vi.fn().mockResolvedValue(new Map()),
    fiscalYearTotals: vi.fn().mockResolvedValue([]),
    upsertAnnualSummaries: vi.fn().mockResolvedValue({ changed: [] }),
    getAnnualSummaries: vi.fn().mockResolvedValue([]),
    recordRun: vi.fn().mockResolvedValue(undefined),
    lastRuns: vi.fn().mockResolvedValue([]),
  };
}

function fakeAffiliationsStore(overrides: Partial<AffiliationsStore> = {}): AffiliationsStore {
  return { upsert: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(null),
    forPerson: vi.fn().mockResolvedValue([]), bulkUpsert: vi.fn().mockResolvedValue(0), ...overrides };
}

function fakeMessage(donationItemId: string, donationBoardId = '1') {
  return { body: { donationItemId, donationBoardId }, ack: vi.fn(), retry: vi.fn() };
}

function fakeMondayClient(overrides: Partial<DonationRollupsMondayClient> = {}): DonationRollupsMondayClient {
  return {
    getItemBoardId: vi.fn().mockResolvedValue('2'),
    getDonorLinkForDonation: vi.fn().mockResolvedValue('donor-1'),
    getDonationState: vi.fn().mockResolvedValue('active'),
    getDonationsByIds: vi.fn().mockResolvedValue([]),
    getOwnerMembership: vi.fn().mockResolvedValue({ statusLabel: null, tierLabel: null, since: null, until: null,
      currentTermStart: null, memberTypeLabel: null, lapseCount: null, lastLapsed: null }),
    getRegistration: vi.fn().mockResolvedValue(null),
    getEventStart: vi.fn().mockResolvedValue(null),
    pageRegistrations: vi.fn().mockResolvedValue({ items: [], cursor: null }),
    pageHistoricalShifts: vi.fn().mockResolvedValue({ items: [], cursor: null }),
    getItemsBoardIds: vi.fn().mockResolvedValue(new Map()),
    listDonationOwnerLinks: vi.fn().mockResolvedValue([]),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    setItemDescription: vi.fn().mockResolvedValue(undefined),
    createUpdate: vi.fn().mockResolvedValue(undefined),
    getAffiliationSummary: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

// Enough ledger rows that the JSON projection blows past the ~60KB write budget.
const oversizedHistory = Array.from({ length: 2_000 }, (_, i) => ({
  mondayItemId: `18427756${String(i).padStart(6, '0')}`, donationBoardId: '1',
  amountCents: 5000, giftDateISO: `${2000 + (i % 26)}-01-15`, fiscalYear: 2000 + (i % 26),
  status: 'Received', giftType: 'Donation', actingForItemId: null, archived: false,
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
        { id: 'dn1', amountCents: 5000, dateISO: '2020-01-15', fiscalYear: 2020, status: 'Received' },
      ]),
    });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore, recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config, now: new Date('2026-01-01') });

    const written = changeColumnValues.mock.calls[0]![2] as Record<string, unknown>;
    expect(JSON.parse(written['glj'] as string)).toEqual([['dn1', '2020-01-15', 5000, 'Donation', 'Received', '']]);
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
        { id: 'dn1', amountCents: 5000, dateISO: '2020-01-15', fiscalYear: 2020, status: 'Received' },
      ]),
    });
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message],
      { pendingStore, linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config, now: new Date('2026-01-01') });
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
        { id: 'dn1', amountCents: 5000, dateISO: '2020-01-15', fiscalYear: 2020, status: 'Received' },
      ]),
      ...overrides,
    });
    return { giftsStore, mondayClient };
  }

  it('truncates the projection instead of letting an over-budget JSON kill the rollup write', async () => {
    const { giftsStore, mondayClient } = oversizedSetup();
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore, recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config, now: new Date('2026-01-01') });

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
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore, recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config: configWithAlert, now: new Date('2026-01-01') });

    expect(createUpdate).toHaveBeenCalledTimes(1);
    const [itemId, body] = createUpdate.mock.calls[0]! as [number, string];
    expect(itemId).toBe(42);
    expect(body).toContain('donor-1'); // the owner whose projection overflowed
    expect(body).toMatch(/\d{5,} bytes/); // the actual size, for the planning decision
  });

  it('alerts (without truncating) already at the 48KB planning threshold', async () => {
    const createUpdate = vi.fn().mockResolvedValue(undefined);
    const giftsStore = fakeGiftsStore();
    (giftsStore.giftsForOwner as ReturnType<typeof vi.fn>).mockResolvedValue(oversizedHistory.slice(0, 900)); // ~56KB with the acting-for element
    const mondayClient = fakeMondayClient({ createUpdate });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore, recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config: configWithAlert, now: new Date('2026-01-01') });

    expect(createUpdate).toHaveBeenCalledTimes(1);
    const written = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2] as Record<string, unknown>;
    expect(JSON.parse(written['glj'] as string)).toHaveLength(900); // still the full projection
  });

  it('a failing alert post never kills the rollup write', async () => {
    const { giftsStore, mondayClient } = oversizedSetup({
      createUpdate: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
    });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message],
      { pendingStore, linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore, recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config: configWithAlert, now: new Date('2026-01-01') });

    expect(message.ack).toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written', expect.anything());
  });

  it('does not alert for an ordinary-sized projection', async () => {
    const createUpdate = vi.fn().mockResolvedValue(undefined);
    const mondayClient = fakeMondayClient({ createUpdate });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config: configWithAlert, now: new Date('2026-01-01') });
    expect(createUpdate).not.toHaveBeenCalled();
  });
});

describe('rollupToColumnValues', () => {
  const LEVEL = { leadershipLifetimeCents: 500000, majorLifetimeCents: 50000, majorLargestCents: 20000,
    labels: { leadership: 'Leadership', major: 'Major', donor: 'Donor' } };
  const rollup = {
    lifetimeGivingCents: 71493, giftCount: 2, firstGiftISO: '2020-01-01',
    thisYearCents: 5000, thisYearCount: 1, lastYearCents: 66493, lastYearCount: 1,
    largestGiftCents: 66493, smallestGiftCents: 5000, averageGiftCents: 35747,
    lastGiftDate: '2024-01-01', lastGiftCents: 5,
  };

  it('writes the Donor Level label when the column and thresholds are configured', () => {
    const values = rollupToColumnValues(rollup, { ...ownerColumns, donorLevel: 'dlv' }, LEVEL);
    expect(values['dlv']).toEqual({ label: 'Major' });
  });

  it('clears Donor Level for an owner with no received gifts', () => {
    const values = rollupToColumnValues({ ...rollup, giftCount: 0, lifetimeGivingCents: 0, largestGiftCents: null },
      { ...ownerColumns, donorLevel: 'dlv' }, LEVEL);
    expect(values['dlv']).toBe('');
  });

  it('writes nothing for Donor Level when the board has no such column', () => {
    expect(Object.keys(rollupToColumnValues(rollup, ownerColumns, LEVEL))).not.toContain('undefined');
  });

  it('writes nothing for Donor Level when the feature is off', () => {
    expect(rollupToColumnValues(rollup, { ...ownerColumns, donorLevel: 'dlv' }, null)).not.toHaveProperty('dlv');
  });

  it('maps every rollup field to its configured column id, nulls stay null', () => {
    const values = rollupToColumnValues({
      lifetimeGivingCents: 71493, giftCount: 2, firstGiftISO: '2020-01-01',
      thisYearCents: 5000, thisYearCount: 1, lastYearCents: 66493, lastYearCount: 1,
      largestGiftCents: 66493, smallestGiftCents: 5000, averageGiftCents: 35747,
      lastGiftDate: '2024-01-01', lastGiftCents: 5,
    }, ownerColumns);
    expect(values).toEqual({
      lg: '714.93', gc: '2', fg: { date: '2020-01-01' },
      tya: '50.00', tyc: '1', lya: '664.93', lyc: '1',
      lag: '664.93', smg: '50.00', avg: '357.47',
      lgd: { date: '2024-01-01' }, lga: '0.05',
    });
  });

  it('writes empty string / null for a donor with no received gifts, not "null" text', () => {
    const values = rollupToColumnValues({
      lifetimeGivingCents: 0, giftCount: 0, firstGiftISO: null,
      thisYearCents: 0, thisYearCount: 0, lastYearCents: 0, lastYearCount: 0,
      largestGiftCents: null, smallestGiftCents: null, averageGiftCents: null,
      lastGiftDate: null, lastGiftCents: null,
    }, ownerColumns);
    expect(values.lg).toBe('0.00');
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
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore({ upsertLink }), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config, now: new Date('2026-01-01') });
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
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore({ getLinksForOwner }), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config, now: new Date('2026-01-01') });
    expect(getDonationsByIds).toHaveBeenCalledTimes(2); // both boards the index has links on
    expect(getDonationsByIds).toHaveBeenCalledWith(['dn1', 'dnOld'], expect.objectContaining({ fiscalYear: 'fy_1' }), 7);
    expect(getDonationsByIds).toHaveBeenCalledWith(['dnHist'], expect.objectContaining({ fiscalYear: null }), 7);
  });

  it('skips a configured board entirely when the index has no links there for this owner', async () => {
    const getDonationsByIds = vi.fn().mockResolvedValue([]);
    const getLinksForOwner = vi.fn().mockResolvedValue(new Map([['1', ['dn1']]])); // nothing on board 9
    const mondayClient = fakeMondayClient({ getDonationsByIds });
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore({ getLinksForOwner }), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config, now: new Date('2026-01-01') });
    expect(getDonationsByIds).toHaveBeenCalledTimes(1);
  });

  // Issue #27: "This Year" is the configured fiscal year in the configured zone — at 5pm Pacific
  // on June 30 (00:00 UTC July 1) FY2026 is still this year.
  it('splits This/Last Year by the fiscal year in config.fiscalYear.timeZone, not UTC', async () => {
    const donations: DonationRecord[] = [
      { id: 'd1', amountCents: 10000, dateISO: '2026-06-15', fiscalYear: 2026, status: 'Received' },
    ];
    const mondayClient = fakeMondayClient({ getDonationsByIds: vi.fn().mockResolvedValue(donations) });
    const run = (now: string) => processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(),
      linksStore: fakeLinksStore({ getLinksForOwner: vi.fn().mockResolvedValue(new Map([['1', ['d1']]])) }),
      affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(),
      volunteerStore: fakeVolunteerStore(), mondayClient, config, now: new Date(now) });

    await run('2026-07-01T00:00:00Z'); // 5pm PDT June 30
    expect(mondayClient.changeColumnValues).toHaveBeenLastCalledWith(2, 'donor-1', expect.objectContaining({ tya: '100.00', lya: '0.00' }));
    await run('2026-07-01T07:00:00Z'); // midnight PDT July 1
    expect(mondayClient.changeColumnValues).toHaveBeenLastCalledWith(2, 'donor-1', expect.objectContaining({ tya: '0.00', lya: '100.00' }));
  });

  it('writes to whichever board the owner item actually lives on, keyed by real board id', async () => {
    const donations: DonationRecord[] = [
      { id: 'd1', amountCents: 10000, dateISO: '2025-08-01', fiscalYear: 2026, status: 'Received' },
    ];
    const mondayClient = fakeMondayClient({
      getItemBoardId: vi.fn().mockResolvedValue('3'), // matches the second configured owner board
      getDonationsByIds: vi.fn().mockResolvedValue(donations),
    });
    const linksStore = fakeLinksStore({ getLinksForOwner: vi.fn().mockResolvedValue(new Map([['1', ['dn1']]])) });
    const pendingStore = fakePendingStore();

    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore, linksStore, affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config, now: new Date('2026-01-01') });

    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(3, 'donor-1', expect.objectContaining({ lg: '100.00' }));
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written',
      expect.objectContaining({ ownerItemId: 'donor-1', ownerBoard: '3' }));
  });

  it('fails loudly (not a silent skip) when the owner lives on a board with no configured columns', async () => {
    const mondayClient = fakeMondayClient({ getItemBoardId: vi.fn().mockResolvedValue('999') }); // not in config
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn1');

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'failed', expect.objectContaining({
      error: expect.stringContaining('999'),
    }));
  });

  it('skips cleanly (no retry) when the donation has no linked owner on Monday or in D1', async () => {
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockResolvedValue(null) });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn3');

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config });

    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn3', 'written', expect.anything());
  });

  it('recomputes via the D1-known owner when the Monday link reads back empty (archived representative gift)', async () => {
    // The July sweep's representative gift is often the owner's oldest, archived gift —
    // its board_relation reads back empty, but donation_links still knows the owner.
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockResolvedValue(null),
      getDonationState: vi.fn().mockResolvedValue('archived') });
    const linksStore = fakeLinksStore({
      getLinkForDonation: vi.fn().mockResolvedValue({ ownerItemId: 'donor-1', ownerBoardId: '2' }),
    });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dnArchived');

    await processRecomputeBatch([message], { pendingStore, linksStore, affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config, now: new Date('2026-01-01') });

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

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config });

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

    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn4', 'failed', { error: 'monday API: HTTP 500' });
  });
});

const BLANK_BOARD: BoardMembership = { statusLabel: null, tierLabel: null, since: null, until: null, currentTermStart: null, memberTypeLabel: null, lapseCount: null, lastLapsed: null };
const ledgerGift = (over: Partial<GiftHistoryRow> = {}): GiftHistoryRow => ({
  mondayItemId: 'dn1', donationBoardId: '1', amountCents: 5000, giftDateISO: '2026-11-05', fiscalYear: 2027,
  status: 'Received', giftType: 'Donation', actingForItemId: null, archived: false, termStart: null, ...over });

describe('membership step (spec 2026-10-09 — full-history fold)', () => {
  function deps(over: {
    board?: Partial<BoardMembership>; history?: GiftHistoryRow[]; volunteers?: VolunteerActivityRow[];
    donations?: unknown[]; ownerBoard?: string; cfg?: DonationRollupsConfig;
  } = {}) {
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const giftsStore = fakeGiftsStore();
    (giftsStore.giftsForOwner as ReturnType<typeof vi.fn>).mockResolvedValue(over.history ?? [ledgerGift()]);
    const volunteerStore = fakeVolunteerStore(over.volunteers ?? []);
    const mondayClient = fakeMondayClient({
      changeColumnValues,
      getItemBoardId: vi.fn().mockResolvedValue(over.ownerBoard ?? '2'),
      getDonationsByIds: vi.fn().mockResolvedValue(over.donations ?? [renewalGift]),
      getOwnerMembership: vi.fn().mockResolvedValue({ ...BLANK_BOARD, ...over.board }),
    });
    return { changeColumnValues, giftsStore, volunteerStore, mondayClient,
      run: () => processRecomputeBatch([fakeMessage('dn1')], {
        pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore, affiliationsStore: fakeAffiliationsStore(),
        recomputesStore: fakeRecomputesStore(), volunteerStore, mondayClient, config: over.cfg ?? membershipEnabled, now: NOW }) };
  }

  it('a never-member with one gift: writes all eight owner columns and stamps the gift New', async () => {
    const d = deps();
    await d.run();
    const [ownerCall, giftCall] = d.changeColumnValues.mock.calls;
    expect(ownerCall![2]).toMatchObject({ ms: { label: 'Active' }, mt: { label: 'Member' }, msince: { date: '2026-11-05' },
      muntil: { date: '2027-12-05' }, mcts: { date: '2026-11-05' }, mtype: { label: 'New' }, mlc: '0' });
    expect(ownerCall![2]).not.toHaveProperty('mll');
    expect(giftCall).toEqual([1, 'dn1', { ts_1: { date: '2026-11-05' }, te_1: { date: '2027-12-05' }, mty_1: 'New' }]);
  });

  it('a lapsed member returning: history from the ledger (not the fetch) gives Lapsed renewal, Lapse Count 1, Since kept', async () => {
    const d = deps({
      history: [ledgerGift({ mondayItemId: 'old', giftDateISO: '2024-01-15', fiscalYear: 2024, archived: true }), ledgerGift()],
      board: { statusLabel: 'Lapsed', tierLabel: 'Member', since: '2024-01-15', until: '2025-02-15' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ ms: { label: 'Active' }, muntil: { date: '2027-12-05' },
      mcts: { date: '2026-11-05' }, mtype: { label: 'Lapsed renewal' }, mlc: '1', mll: { date: '2025-02-15' } });
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('msince');
    expect(d.changeColumnValues.mock.calls[1]![2]).toMatchObject({ mty_1: 'Lapsed renewal' });
  });

  it('a migrated $0 term before fromISO counts; Member Since moves earlier than the board only via min', async () => {
    const d = deps({
      history: [ledgerGift({ mondayItemId: 'mig', amountCents: 0, giftDateISO: '2019-05-01', fiscalYear: 2019, termStart: '2019-05-01' }), ledgerGift()],
      board: { since: '2015-01-01' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('msince');   // board 2015 is earlier: kept
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ mlc: '1', mll: { date: '2020-06-01' } });
  });

  it('a check-in alone makes a member and stamps no gift', async () => {
    const d = deps({ history: [], donations: [], volunteers: [{ registrationItemId: 'r1', boardId: 'er', ownerItemId: 'donor-1', ownerBoardId: '2',
      activityDateISO: '2026-10-20', hours: null, qualifies: true, source: 'webhook' }] });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ ms: { label: 'Active' }, msince: { date: '2026-10-20' }, muntil: { date: '2027-11-20' }, mtype: { label: 'New' } });
  });

  it('a $1,000 gift makes the owner Lifetime with Until cleared and a blank Term End', async () => {
    const d = deps({ history: [ledgerGift({ amountCents: 100000 })], donations: [{ ...renewalGift, amountCents: 100000 }],
      board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2027-04-11' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).toMatchObject({ mt: { label: 'Lifetime' }, muntil: null });
    expect(d.changeColumnValues.mock.calls[1]![2]).toEqual({ ts_1: { date: '2026-11-05' }, mty_1: 'Lifetime' });
  });

  it('a board-Lifetime owner (migrated, not from the ledger) gets no New/Continuing gift stamps and no Until', async () => {
    const d = deps({
      history: [ledgerGift({ mondayItemId: 'mig', amountCents: 0, giftDateISO: '2019-05-01', fiscalYear: 2019, termStart: '2019-05-01' }),
        ledgerGift({ giftDateISO: '2026-11-01' })],
      donations: [{ ...renewalGift, dateISO: '2026-11-01' }],
      board: { statusLabel: 'Active', tierLabel: 'Lifetime', since: '2019-05-01', until: null } });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);   // the owner write only — no gift stamp
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('muntil');
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('mt');
  });

  it('a staff-extended Until on the board is kept (extend-only merge)', async () => {
    const d = deps({ board: { statusLabel: 'Active', tierLabel: 'Member', since: '2015-01-01', until: '2029-01-01' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('muntil');
  });

  it('an Organizations owner (no membership columns) gets no membership writes', async () => {
    const d = deps({ ownerBoard: '3' });
    await d.run();
    expect(d.mondayClient.getOwnerMembership).not.toHaveBeenCalled();
    expect(d.volunteerStore.forOwner).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('with the membership block null the step is skipped entirely', async () => {
    const d = deps({ cfg: { ...membershipEnabled, donationRollups: { ...membershipEnabled.donationRollups, membership: null } } });
    await d.run();
    expect(d.mondayClient.getOwnerMembership).not.toHaveBeenCalled();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('no qualifying activity at all: nothing membership-related is written even when the board is stale', async () => {
    const d = deps({ history: [ledgerGift({ amountCents: 50 })], donations: [{ ...renewalGift, amountCents: 50 }],
      board: { statusLabel: 'Lapsed', tierLabel: 'Lifetime', since: '2015-01-01', until: '2027-01-01' } });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
    for (const key of ['ms', 'mt', 'msince', 'muntil', 'mcts', 'mtype', 'mlc', 'mll']) expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty(key);
  });

  it('writes nothing on a re-run whose board already matches', async () => {
    const d = deps({ board: { statusLabel: 'Active', tierLabel: 'Member', since: '2026-11-05', until: '2027-12-05', currentTermStart: '2026-11-05', memberTypeLabel: 'New', lapseCount: 0, lastLapsed: null },
      donations: [{ ...renewalGift, termStart: '2026-11-05', termEnd: '2027-12-05', membershipType: 'New' }] });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
    expect(d.changeColumnValues.mock.calls[0]![2]).not.toHaveProperty('ms');
  });

  it('caps gift term stamps per recompute and continues on later recomputes', async () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ ...renewalGift, id: `g${String(i).padStart(2, '0')}`, dateISO: `2026-11-${String(i + 1).padStart(2, '0')}` }));
    const d = deps({ donations: many, history: many.map((g) => ledgerGift({ mondayItemId: g.id, giftDateISO: g.dateISO })) });
    await d.run();
    expect(d.changeColumnValues).toHaveBeenCalledTimes(11);
    expect(d.changeColumnValues.mock.calls.slice(1).map((c) => c[1])).toEqual(many.slice(0, 10).map((g) => g.id));
  });

  it('the owner write precedes the gift writes, and a failing gift write still retries the message', async () => {
    const d = deps();
    d.changeColumnValues.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('monday API: HTTP 500'));
    const message = fakeMessage('dn1');
    const recomputesStore = fakeRecomputesStore();
    await processRecomputeBatch([message], {
      pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore: d.giftsStore, affiliationsStore: fakeAffiliationsStore(),
      recomputesStore, volunteerStore: d.volunteerStore, mondayClient: d.mondayClient, config: membershipEnabled, now: NOW,
    });
    expect(d.changeColumnValues.mock.calls[0]![1]).toBe('donor-1');
    expect(message.retry).toHaveBeenCalled();
    // Fix 3 guard: the owner must NOT be recorded as freshly recomputed when a gift stamp
    // failed, or the retry would be coalesced away and the stamps never land.
    expect(recomputesStore.record).not.toHaveBeenCalled();
  });
});

// Fix 3 (README "operational findings, 2026-09-17"): a bulk edit recomputes a big owner once per
// donation. A message whose owner was already fetched from Monday at/after this donation's
// webhook arrived — and whose link pre-dates that fetch — has nothing new to compute.
describe('owner recompute coalescing (fix 3)', () => {
  const RX = '2026-09-03T19:20:00.000Z';
  const pendingRow = { donationItemId: 'dn1', donationBoardId: '1', eventId: 'e', status: 'queued' as const,
    ownerItemId: null, ownerBoard: null, error: null, receivedAt: RX, writtenAt: null };
  const fresh: OwnerRecompute = { ownerItemId: 'donor-1', ownerBoardId: '2', fetchedAt: '2026-09-03T19:20:30.000Z', writtenAt: '2026-09-03T19:20:40.000Z' };
  const stale: OwnerRecompute = { ...fresh, fetchedAt: '2026-09-03T19:19:00.000Z', writtenAt: '2026-09-03T19:20:10.000Z' };

  function run(opts: { last: OwnerRecompute | null; link?: { changed: boolean; updatedAt: string }; pending?: typeof pendingRow | null }) {
    const pendingStore = fakePendingStore({ getPending: vi.fn().mockResolvedValue(opts.pending === undefined ? pendingRow : opts.pending) });
    const linksStore = fakeLinksStore(opts.link ? { upsertLink: vi.fn().mockResolvedValue(opts.link) } : {});
    const recomputesStore = fakeRecomputesStore(opts.last);
    const mondayClient = fakeMondayClient();
    const message = fakeMessage('dn1');
    const done = processRecomputeBatch([message],
      { pendingStore, linksStore, affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore, volunteerStore: fakeVolunteerStore(), mondayClient, config });
    return { done, pendingStore, linksStore, recomputesStore, mondayClient, message };
  }

  it('skips the recompute when the owner was fetched after this webhook arrived and the link pre-dates that fetch', async () => {
    const { done, pendingStore, recomputesStore, mondayClient, message } = run({ last: fresh });
    await done;
    expect(mondayClient.getDonationsByIds).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(recomputesStore.record).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written',
      expect.objectContaining({ ownerItemId: 'donor-1', ownerBoard: '2', writtenAt: expect.any(String) }));
    expect(message.ack).toHaveBeenCalled();
  });

  it('recomputes when the owner was last fetched before this webhook arrived', async () => {
    const { done, mondayClient } = run({ last: stale });
    await done;
    expect(mondayClient.getDonationsByIds).toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalled();
  });

  it('recomputes a fresh owner when this donation\'s link is new or re-owned (the fresh fetch could not have covered it)', async () => {
    const { done, mondayClient } = run({ last: fresh, link: { changed: true, updatedAt: '2026-09-03T19:21:00.000Z' } });
    await done;
    expect(mondayClient.getDonationsByIds).toHaveBeenCalled();
  });

  it('recomputes a fresh owner when the link was (re)written after the fetch, even if unchanged now', async () => {
    const { done, mondayClient } = run({ last: fresh, link: { changed: false, updatedAt: '2026-09-03T19:20:35.000Z' } });
    await done;
    expect(mondayClient.getDonationsByIds).toHaveBeenCalled();
  });

  it('recomputes when there is no pending row to compare against (e.g. a custodian sweep message)', async () => {
    const { done, mondayClient } = run({ last: fresh, pending: null });
    await done;
    expect(mondayClient.getDonationsByIds).toHaveBeenCalled();
  });

  it('a successful recompute records the owner with fetched_at taken before the Monday fetch and written_at after the write', async () => {
    const order: string[] = [];
    const mondayClient = fakeMondayClient({
      getDonationsByIds: vi.fn().mockImplementation(async () => { order.push('fetch'); return []; }),
      changeColumnValues: vi.fn().mockImplementation(async () => { order.push('write'); }),
    });
    const recomputesStore = fakeRecomputesStore(null);
    (recomputesStore.record as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('record'); });
    const before = new Date().toISOString();
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore, volunteerStore: fakeVolunteerStore(), mondayClient, config });
    const after = new Date().toISOString();

    expect(order).toEqual(['fetch', 'write', 'record']);
    const row = (recomputesStore.record as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OwnerRecompute;
    expect(row.ownerItemId).toBe('donor-1');
    expect(row.ownerBoardId).toBe('2');
    expect(row.fetchedAt >= before && row.fetchedAt <= row.writtenAt && row.writtenAt <= after).toBe(true);
  });

  it('a failed recompute records nothing, so the next message for that owner still recomputes', async () => {
    const mondayClient = fakeMondayClient({ changeColumnValues: vi.fn().mockRejectedValue(new Error('monday down')) });
    const recomputesStore = fakeRecomputesStore(null);
    await processRecomputeBatch([fakeMessage('dn1')],
      { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), affiliationsStore: fakeAffiliationsStore(), giftsStore: fakeGiftsStore(), recomputesStore, volunteerStore: fakeVolunteerStore(), mondayClient, config });
    expect(recomputesStore.record).not.toHaveBeenCalled();
  });
});

// Fix 4 (README "operational findings, 2026-09-17"): when D1 rejects writes for the day, the
// old catch block's own 'failed' status write threw, escaped the loop, the batch retried
// immediately, and three fast retries later every message was dead in a consumer-less DLQ.
describe('D1 quota outage handling (fix 4)', () => {
  const QUOTA = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.");
  // The minute the 09-03 flood stalled — 3h51m before midnight UTC.
  const STALL = new Date('2026-09-03T20:09:00Z');
  const DELAY = 3 * 3600 + 51 * 60;

  function base(over: { pendingStore?: PendingStore; linksStore?: DonationLinksStore; mondayClient?: DonationRollupsMondayClient } = {}) {
    return {
      pendingStore: over.pendingStore ?? fakePendingStore(), linksStore: over.linksStore ?? fakeLinksStore(),
      giftsStore: fakeGiftsStore(), recomputesStore: fakeRecomputesStore(), affiliationsStore: fakeAffiliationsStore(), volunteerStore: fakeVolunteerStore(),
      mondayClient: over.mondayClient ?? fakeMondayClient(), config, now: STALL,
    };
  }

  it('a D1 quota error retries the message after midnight UTC instead of immediately, and does not ack', async () => {
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message], base({ linksStore: fakeLinksStore({ upsertLink: vi.fn().mockRejectedValue(QUOTA) }) }));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: DELAY });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('a plain Monday error retries after a backoff, not immediately (#35)', async () => {
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message], base({ mondayClient: fakeMondayClient({ changeColumnValues: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')) }) }));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it('a throwing failed-status write is logged and the batch continues with the next message', async () => {
    const pendingStore = fakePendingStore({
      updateStatus: vi.fn().mockImplementation(async (id: string, status: string) => {
        if (id === 'dn1' && status === 'failed') throw QUOTA;
      }),
    });
    const mondayClient = fakeMondayClient({
      changeColumnValues: vi.fn().mockRejectedValueOnce(new Error('monday API: HTTP 500')).mockResolvedValue(undefined),
    });
    const first = fakeMessage('dn1');
    const second = fakeMessage('dn2');

    await processRecomputeBatch([first, second], base({ pendingStore, mondayClient }));

    expect(first.retry).toHaveBeenCalled();
    expect(second.ack).toHaveBeenCalled();
  });

  it('after one quota error the rest of the batch is deferred with the same delay without calling Monday', async () => {
    const linksStore = fakeLinksStore({ upsertLink: vi.fn().mockRejectedValue(QUOTA) });
    const mondayClient = fakeMondayClient();
    const messages = [fakeMessage('dn1'), fakeMessage('dn2'), fakeMessage('dn3')];

    await processRecomputeBatch(messages, base({ linksStore, mondayClient }));

    expect(mondayClient.getDonorLinkForDonation).toHaveBeenCalledTimes(1);
    for (const m of messages) {
      expect(m.retry).toHaveBeenCalledWith({ delaySeconds: DELAY });
      expect(m.ack).not.toHaveBeenCalled();
    }
  });
});

// Issue #27: a Monday rate-limit or complexity-budget error used to retry immediately — into
// the same exhausted budget — and three fast retries later the message was in the DLQ.
describe('Monday rate-limit handling (issue #27)', () => {
  function base(mondayClient: DonationRollupsMondayClient) {
    return {
      pendingStore: fakePendingStore(), linksStore: fakeLinksStore(), giftsStore: fakeGiftsStore(),
      recomputesStore: fakeRecomputesStore(), affiliationsStore: fakeAffiliationsStore(), volunteerStore: fakeVolunteerStore(),
      mondayClient, config,
    };
  }
  const budget = (retryInSeconds?: number) => new MondayRateLimitError('monday API: Complexity budget exhausted', retryInSeconds);

  it('retries a rate-limited message after a delay, not immediately, and does not ack', async () => {
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message], base(fakeMondayClient({ changeColumnValues: vi.fn().mockRejectedValue(budget()) })));

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("honors Monday's retry_in_seconds and backs off by delivery attempt", async () => {
    const hinted = fakeMessage('dn1');
    await processRecomputeBatch([hinted], base(fakeMondayClient({ changeColumnValues: vi.fn().mockRejectedValue(budget(300)) })));
    expect(hinted.retry).toHaveBeenCalledWith({ delaySeconds: 300 });

    const third = { ...fakeMessage('dn1'), attempts: 3 };
    await processRecomputeBatch([third], base(fakeMondayClient({ changeColumnValues: vi.fn().mockRejectedValue(budget(5)) })));
    expect(third.retry).toHaveBeenCalledWith({ delaySeconds: 240 });
  });

  // Monday's daily call limit resets at midnight UTC (developer.monday.com rate-limits doc) and
  // DAILY_LIMIT_EXCEEDED isn't documented to carry a retry hint: backing off 60/120/240s would
  // spend every retry within minutes of a reset that is hours away.
  describe('daily limit (DAILY_LIMIT_EXCEEDED)', () => {
    const daily = (retryInSeconds?: number) =>
      new MondayRateLimitError('monday API: Daily limit exceeded', retryInSeconds, true);

    it('with no hint, defers this and the rest of the batch to midnight UTC', async () => {
      const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockRejectedValue(daily()) });
      const messages = [{ ...fakeMessage('dn1'), attempts: 3 }, fakeMessage('dn2')];
      await processRecomputeBatch(messages, { ...base(mondayClient), now: new Date('2026-09-03T20:09:00Z') });

      expect(mondayClient.getDonorLinkForDonation).toHaveBeenCalledTimes(1);
      for (const m of messages) expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 3 * 3600 + 51 * 60 });
    });

    it("caps at Queues' 12 h when midnight UTC is further away, like the D1-quota path", async () => {
      const message = fakeMessage('dn1');
      await processRecomputeBatch([message], { ...base(fakeMondayClient({ changeColumnValues: vi.fn().mockRejectedValue(daily()) })),
        now: new Date('2026-09-09T01:58:00Z') });
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 43_200 });
    });

    it('with a hint, honors the hint as for any other rate limit', async () => {
      const message = fakeMessage('dn1');
      await processRecomputeBatch([message], base(fakeMondayClient({ changeColumnValues: vi.fn().mockRejectedValue(daily(500)) })));
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 500 });
    });
  });

  it('defers the rest of the batch with the same delay without calling Monday again', async () => {
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockRejectedValue(budget(90)) });
    const messages = [fakeMessage('dn1'), fakeMessage('dn2')];

    await processRecomputeBatch(messages, base(mondayClient));

    expect(mondayClient.getDonorLinkForDonation).toHaveBeenCalledTimes(1);
    for (const m of messages) {
      expect(m.retry).toHaveBeenCalledWith({ delaySeconds: 90 });
      expect(m.ack).not.toHaveBeenCalled();
    }
  });
});

const affiliationsCfg = { boardId: 555, columns: { personLink: 'br_p', attributedGiving: 'n_ag', attributedGiftCount: 'n_agc', lastAttributedGift: 'd_lag' } };
const configWithAffiliations: DonationRollupsConfig = {
  ...config,
  affiliations: affiliationsCfg,
  donationRollups: { ...config.donationRollups,
    donationBoards: config.donationRollups.donationBoards.map((b) => ({ ...b, columns: { ...b.columns, actingForLink: `af_${b.boardId}` } })),
    ownerColumnsByBoard: { '2': { ...ownerColumns, organizationalGiving: 'og' }, '3': ownerColumns } },
};

describe('affectedAffiliations', () => {
  it('unions the triggering donation\'s previous and current acting-for ids, ignoring nulls', () => {
    expect([...affectedAffiliations(new Map([['dn1', 'af-old'], ['dn2', null]]),
      [{ id: 'dn1', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-new' },
       { id: 'dn2', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: null }],
      'dn1')].sort())
      .toEqual(['af-new', 'af-old']);
  });

  it('an unchanged non-triggering gift contributes nothing', () => {
    expect([...affectedAffiliations(new Map([['dn1', 'af-trigger'], ['dn2', 'af-unchanged']]),
      [{ id: 'dn1', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-trigger' },
       { id: 'dn2', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-unchanged' }],
      'dn1')])
      .toEqual(['af-trigger']);
  });

  it('the triggering gift\'s affiliation is included even when unchanged', () => {
    expect([...affectedAffiliations(new Map([['dn1', 'af-same']]),
      [{ id: 'dn1', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-same' }],
      'dn1')])
      .toEqual(['af-same']);
  });

  it('a changed non-triggering gift contributes both its old and new affiliation', () => {
    expect([...affectedAffiliations(new Map([['dn1', 'af-trigger'], ['dn2', 'af-old']]),
      [{ id: 'dn1', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-trigger' },
       { id: 'dn2', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-new' }],
      'dn1')].sort())
      .toEqual(['af-new', 'af-old', 'af-trigger']);
  });

  // Review finding 1: donation_links includes archived gifts, and D1 preserves an archived
  // gift's acting_for_item_id forever while Monday reads its board_relation back as null —
  // without the null-current guard, previous !== current fires on every recompute for every
  // archived attributed gift, fanning out to every affiliation an org owner ever had.
  it('a non-triggering archived gift whose fetched value reads back null contributes nothing (finding 1)', () => {
    expect([...affectedAffiliations(new Map([['dn1', 'af-trigger'], ['dn2', 'af-archived']]),
      [{ id: 'dn1', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-trigger' },
       { id: 'dn2', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: null }],
      'dn1')])
      .toEqual(['af-trigger']);
  });

  it('the same previous/current-null shape on the TRIGGERING gift is still a genuine clear (finding 1)', () => {
    expect([...affectedAffiliations(new Map([['dn1', 'af-archived']]),
      [{ id: 'dn1', amountCents: 100, dateISO: '2024-01-01', fiscalYear: 2024, status: 'Received', actingForItemId: null }],
      'dn1')])
      .toEqual(['af-archived']);
  });
});

describe('consumer phase 2 — affiliation rollups', () => {
  const donation = { id: 'dn1', amountCents: 50000, dateISO: '2024-02-02', fiscalYear: 2024, status: 'Received', actingForItemId: 'af-1' };
  function setup(over: { giftsStore?: Partial<GiftsStore>; affiliationsStore?: Partial<AffiliationsStore>; monday?: Partial<DonationRollupsMondayClient> } = {}) {
    const giftsStore = { ...fakeGiftsStore(), ...over.giftsStore } as GiftsStore;
    (giftsStore.attributedTotals as ReturnType<typeof vi.fn>).mockResolvedValue({ cents: 50000, count: 1, lastGiftDateISO: '2024-02-02' });
    (giftsStore.organizationalGivingTotals as ReturnType<typeof vi.fn>).mockResolvedValue({ cents: 50000, count: 1 });
    const mondayClient = fakeMondayClient({
      getDonationsByIds: vi.fn().mockResolvedValue([donation]),
      getAffiliationSummary: vi.fn().mockResolvedValue({ name: 'Uma @ Beta', personItemId: 'p-1', personBoardId: '2' }),
      ...over.monday });
    const affiliationsStore = fakeAffiliationsStore(over.affiliationsStore);
    return { giftsStore, mondayClient, affiliationsStore };
  }

  it('writes the three attributed columns on the Affiliations board and Organizational Giving on the person', async () => {
    const { giftsStore, mondayClient, affiliationsStore } = setup();
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(mondayClient.getDonationsByIds).toHaveBeenCalledWith(['dn1'], expect.objectContaining({ actingForLink: 'af_1' }), 7);
    expect(giftsStore.refreshFacts).toHaveBeenCalledWith([expect.objectContaining({ mondayItemId: 'dn1', actingForItemId: 'af-1' })], 'webhook', expect.any(String));
    expect(mondayClient.getAffiliationSummary).toHaveBeenCalledWith('af-1', 'br_p');
    expect(affiliationsStore.upsert).toHaveBeenCalledWith({ affiliationItemId: 'af-1', personItemId: 'p-1', personBoardId: '2', name: 'Uma @ Beta' }, expect.any(String));
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(555, 'af-1', { n_ag: '500.00', n_agc: '1', d_lag: { date: '2024-02-02' } });
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'p-1', { og: '500.00' });
  });

  it('recomputes the affiliation a gift moved away from, and the person it used to belong to', async () => {
    const { giftsStore, mondayClient, affiliationsStore } = setup({
      giftsStore: { actingForByIds: vi.fn().mockResolvedValue(new Map([['dn1', 'af-old']])) },
      affiliationsStore: { get: vi.fn().mockImplementation(async (id: string) =>
        id === 'af-old' ? { affiliationItemId: 'af-old', personItemId: 'p-old', personBoardId: '2', name: 'Old @ Org' } : null) },
      monday: { getAffiliationSummary: vi.fn().mockImplementation(async (id: string) =>
        ({ name: `${id} name`, personItemId: id === 'af-old' ? 'p-old' : 'p-1', personBoardId: '2' })) },
    });
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(555, 'af-old', expect.anything());
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(555, 'af-1', expect.anything());
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'p-old', { og: '500.00' });
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'p-1', { og: '500.00' });
  });

  it('skips Organizational Giving with a warning when the person board has no such column, and skips a deleted affiliation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { giftsStore, mondayClient, affiliationsStore } = setup({
      monday: { getAffiliationSummary: vi.fn().mockResolvedValue({ name: 'X @ Y', personItemId: 'p-3', personBoardId: '3' }) } });
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalledWith(3, 'p-3', expect.anything());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no organizationalGiving column for board "3"'));
    warn.mockRestore();

    const gone = setup({ monday: { getAffiliationSummary: vi.fn().mockResolvedValue(null) } });
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), giftsStore: gone.giftsStore, affiliationsStore: gone.affiliationsStore, mondayClient: gone.mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(message.ack).toHaveBeenCalled();
    expect(gone.mondayClient.changeColumnValues).not.toHaveBeenCalledWith(555, expect.anything(), expect.anything());
  });

  it('a fresh summary for one affiliation wins over a stale D1 row for the same person held by another (finding 2)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const giftsStore = fakeGiftsStore();
    // Order matters here: affectedAffiliations walks donations in order (dn1 then dn2), so
    // aff-a is processed — and its fresh summary written to `persons` — before aff-b, whose
    // unconditional `persons.set(previous...)` at the top of its own iteration is the thing
    // under test: it must not clobber aff-a's fresh entry for the same person.
    (giftsStore.actingForByIds as ReturnType<typeof vi.fn>).mockResolvedValue(new Map([['dn1', 'aff-a'], ['dn2', 'aff-b']]));
    (giftsStore.attributedTotals as ReturnType<typeof vi.fn>).mockResolvedValue({ cents: 50000, count: 1, lastGiftDateISO: '2024-02-02' });
    (giftsStore.organizationalGivingTotals as ReturnType<typeof vi.fn>).mockResolvedValue({ cents: 50000, count: 1 });
    const donations = [
      { id: 'dn1', amountCents: 50000, dateISO: '2024-02-02', fiscalYear: 2024, status: 'Received', actingForItemId: 'aff-a' },
      { id: 'dn2', amountCents: 10000, dateISO: '2024-02-02', fiscalYear: 2024, status: 'Received', actingForItemId: null },
    ];
    const mondayClient = fakeMondayClient({
      getDonationsByIds: vi.fn().mockResolvedValue(donations),
      // aff-a resolves person p-shared to board 2 (fresh); aff-b is deleted on Monday.
      getAffiliationSummary: vi.fn().mockImplementation(async (id: string) =>
        id === 'aff-a' ? { name: 'A name', personItemId: 'p-shared', personBoardId: '2' } : null),
    });
    const affiliationsStore = fakeAffiliationsStore({
      // aff-b's stale D1 row says p-shared lived on board 3.
      get: vi.fn().mockImplementation(async (id: string) =>
        id === 'aff-b' ? { affiliationItemId: 'aff-b', personItemId: 'p-shared', personBoardId: '3', name: 'Stale @ Org' } : null),
    });
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'p-shared', { og: '500.00' });
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalledWith(3, 'p-shared', expect.anything());
    warn.mockRestore();
  });

  it('gift-history description gains a "Driven for organizations" section when the owner drives affiliated giving', async () => {
    const { giftsStore, mondayClient, affiliationsStore } = setup({
      affiliationsStore: { forPerson: vi.fn().mockResolvedValue([
        { affiliationItemId: 'af-1', personItemId: 'donor-1', personBoardId: '2', name: 'Uma @ Beta Org' },
      ]) },
    });
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(affiliationsStore.forPerson).toHaveBeenCalledWith('donor-1');
    expect(mondayClient.setItemDescription).toHaveBeenCalledWith('donor-1', expect.stringContaining('Driven for organizations'));
  });

  it('does nothing extra when affiliations is null (gate off)', async () => {
    const { giftsStore, mondayClient, affiliationsStore } = setup();
    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore: fakePendingStore(), linksStore: fakeLinksStore(),
      recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), giftsStore, affiliationsStore, mondayClient, config, now: new Date('2026-01-01') });
    expect(mondayClient.getAffiliationSummary).not.toHaveBeenCalled();
    expect(giftsStore.actingForByIds).not.toHaveBeenCalled();
    expect(affiliationsStore.forPerson).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledTimes(1);   // the owner write only
  });

  it('driven computation D1 failure is non-fatal — rollups and markdown land, message acks', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { giftsStore, mondayClient, affiliationsStore } = setup({
      affiliationsStore: { forPerson: vi.fn().mockRejectedValue(new Error('D1 hiccup')) },
    });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn1');
    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(),
      recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written', expect.anything());
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'donor-1', expect.anything());
    // Review finding 12: driven's own D1 hiccup must not cost the gift-history description
    // write — it still lands, just without the "Driven for organizations" section.
    expect(mondayClient.setItemDescription).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('driven-for-organizations skipped'));
    warn.mockRestore();
  });

  it('a phase-2 Monday failure retries the message (owner write is idempotent)', async () => {
    const { giftsStore, mondayClient, affiliationsStore } = setup({
      monday: { changeColumnValues: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('monday API: HTTP 500')) } });
    const message = fakeMessage('dn1');
    const pendingStore = fakePendingStore();
    await processRecomputeBatch([message], { pendingStore, linksStore: fakeLinksStore(),
      recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(), giftsStore, affiliationsStore, mondayClient, config: configWithAffiliations, now: new Date('2026-01-01') });
    expect(message.retry).toHaveBeenCalled();
    expect(pendingStore.updateStatus).not.toHaveBeenCalledWith('dn1', 'written', expect.anything());
  });
});

describe('totals decrease when a gift leaves its owner (issue #26)', () => {
  const deps = (over: { mondayClient: DonationRollupsMondayClient; linksStore?: DonationLinksStore; giftsStore?: GiftsStore;
    pendingStore?: PendingStore; queue?: NonNullable<ProcessBatchDeps['queue']> }): ProcessBatchDeps => ({
    pendingStore: over.pendingStore ?? fakePendingStore(), linksStore: over.linksStore ?? fakeLinksStore(),
    giftsStore: over.giftsStore ?? fakeGiftsStore(), affiliationsStore: fakeAffiliationsStore(),
    recomputesStore: fakeRecomputesStore(), volunteerStore: fakeVolunteerStore(),
    mondayClient: over.mondayClient, config, now: new Date('2026-01-01'),
    ...(over.queue ? { queue: over.queue } : {}),
  });

  for (const state of ['active', 'deleted'] as const) {
    it(`a ${state === 'active' ? 'gift whose Donor link was cleared' : 'deleted gift'} is detached and its former owner recomputed without it`, async () => {
      const mondayClient = fakeMondayClient({
        getDonorLinkForDonation: vi.fn().mockResolvedValue(null),
        getDonationState: vi.fn().mockResolvedValue(state),
        getDonationsByIds: vi.fn().mockResolvedValue([]), // the only remaining link set is empty
      });
      const linksStore = fakeLinksStore({
        getLinkForDonation: vi.fn().mockResolvedValue({ ownerItemId: 'donor-1', ownerBoardId: '2' }),
        getLinksForOwner: vi.fn().mockResolvedValue(new Map()),
      });
      const giftsStore = fakeGiftsStore();
      (giftsStore.markRemoved as ReturnType<typeof vi.fn>).mockResolvedValue({ ownerItemId: 'donor-1', ownerBoardId: '2', actingForItemId: null });
      const pendingStore = fakePendingStore();
      const message = fakeMessage('dnGone');

      await processRecomputeBatch([message], deps({ mondayClient, linksStore, giftsStore, pendingStore }));

      expect(giftsStore.markRemoved).toHaveBeenCalledWith('dnGone', expect.any(String));
      expect(linksStore.deleteLink).toHaveBeenCalledWith('dnGone');
      expect(linksStore.upsertLink).not.toHaveBeenCalled(); // never re-attached to the old owner
      // The former owner is rewritten with zeroed totals, not left holding the gift.
      const [board, owner, values] = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect([board, owner]).toEqual([2, 'donor-1']);
      expect((values as Record<string, unknown>)['lg']).toBe('0.00');
      expect((values as Record<string, unknown>)['gc']).toBe('0');
      expect(message.ack).toHaveBeenCalled();
      expect(pendingStore.updateStatus).toHaveBeenCalledWith('dnGone', 'written', expect.anything());
    });
  }

  it('an archived gift still falls back to its D1 owner and is NOT detached', async () => {
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockResolvedValue(null),
      getDonationState: vi.fn().mockResolvedValue('archived') });
    const linksStore = fakeLinksStore({ getLinkForDonation: vi.fn().mockResolvedValue({ ownerItemId: 'donor-1', ownerBoardId: '2' }) });
    const giftsStore = fakeGiftsStore();
    await processRecomputeBatch([fakeMessage('dnArch')], deps({ mondayClient, linksStore, giftsStore }));
    expect(giftsStore.markRemoved).not.toHaveBeenCalled();
    expect(linksStore.deleteLink).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'donor-1', expect.anything());
  });

  it('a detached gift unknown to D1 is a clean no-op', async () => {
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockResolvedValue(null) });
    const message = fakeMessage('dnStranger');
    await processRecomputeBatch([message], deps({ mondayClient }));
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });

  it('a gift moved to a new owner queues a recompute of the owner it left', async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const linksStore = fakeLinksStore({
      upsertLink: vi.fn().mockResolvedValue({ changed: true, updatedAt: '2026-01-01T00:00:00Z',
        previousOwner: { ownerItemId: 'donor-old', ownerBoardId: '3' } }),
    });
    const mondayClient = fakeMondayClient();
    await processRecomputeBatch([fakeMessage('dnMoved')], deps({ mondayClient, linksStore, queue }));
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'donor-1', expect.anything()); // new owner now
    expect(queue.send).toHaveBeenCalledWith({ donationItemId: 'dnMoved', donationBoardId: '1',
      ownerItemId: 'donor-old', ownerBoardId: '3' });
    const changeOrder = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    expect(queue.send.mock.invocationCallOrder[0]!).toBeLessThan(changeOrder);
  });

  it('an owner-keyed message recomputes that owner directly, never coalesced and without touching the donation', async () => {
    const mondayClient = fakeMondayClient();
    const linksStore = fakeLinksStore({ getLinksForOwner: vi.fn().mockResolvedValue(new Map()) });
    const pendingStore = fakePendingStore();
    const message = { body: { donationItemId: 'dnMoved', donationBoardId: '1', ownerItemId: 'donor-old', ownerBoardId: '3' },
      ack: vi.fn(), retry: vi.fn() };
    await processRecomputeBatch([message], deps({ mondayClient, linksStore, pendingStore }));
    expect(mondayClient.getDonorLinkForDonation).not.toHaveBeenCalled();
    expect(linksStore.getLinksForOwner).toHaveBeenCalledWith('donor-old');
    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(3, 'donor-old', expect.anything());
    expect(pendingStore.updateStatus).not.toHaveBeenCalledWith('dnMoved', 'written', expect.anything());
    expect(message.ack).toHaveBeenCalled();
  });
});

describe('registration messages (kind: registration)', () => {
  const volunteerBoard = { boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: null },
    eventBoard: { boardId: 8, columns: { start: 'start' } }, volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'] };
  const cfg: DonationRollupsConfig = { ...membershipEnabled, donationRollups: { ...membershipEnabled.donationRollups, volunteerBoards: [volunteerBoard] } };
  const reg = (over = {}) => ({ id: 'r1', attendeeItemId: 'p1', eventItemId: 'e1', attendanceLabel: 'Attended', roleLabel: 'Volunteer', hours: null, ...over });
  const regMessage = () => ({ body: { kind: 'registration' as const, donationItemId: 'r1', donationBoardId: '7' }, ack: vi.fn(), retry: vi.fn() });

  function deps(over: { registration?: unknown; eventStart?: string | null; previousOwner?: { ownerItemId: string; ownerBoardId: string } | null; ownerBoard?: string } = {}) {
    const changeColumnValues = vi.fn().mockResolvedValue(undefined);
    const volunteerStore = fakeVolunteerStore();
    (volunteerStore.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({ previousOwner: over.previousOwner ?? null });
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const pendingStore = fakePendingStore();
    const mondayClient = fakeMondayClient({
      changeColumnValues,
      getRegistration: vi.fn().mockResolvedValue(over.registration === undefined ? reg() : over.registration),
      getEventStart: vi.fn().mockResolvedValue(over.eventStart === undefined ? '2027-05-02' : over.eventStart),
      getItemBoardId: vi.fn().mockResolvedValue(over.ownerBoard ?? '2'),
      getDonationsByIds: vi.fn().mockResolvedValue([]),
    });
    const linksStore = fakeLinksStore({ getLinksForOwner: vi.fn().mockResolvedValue(new Map()) });
    return { changeColumnValues, volunteerStore, queue, pendingStore, mondayClient,
      run: (message = regMessage()) => processRecomputeBatch([message], {
        pendingStore, linksStore, giftsStore: fakeGiftsStore(), affiliationsStore: fakeAffiliationsStore(),
        recomputesStore: fakeRecomputesStore(), volunteerStore, mondayClient, config: cfg, queue, now: NOW }) };
  }

  it('a qualifying check-in is stored and recomputes the attendee', async () => {
    const d = deps();
    await d.run();
    expect(d.volunteerStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      registrationItemId: 'r1', boardId: '7', ownerItemId: 'p1', ownerBoardId: '2', activityDateISO: '2027-05-02', hours: null, qualifies: true, source: 'webhook' }), expect.any(String));
    expect(d.changeColumnValues.mock.calls[0]![1]).toBe('p1');
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('r1', 'written', expect.objectContaining({ ownerItemId: 'p1' }));
  });

  it('an undated Event stores qualifies=false and still recomputes the attendee (Review Focus 1)', async () => {
    const d = deps({ eventStart: null });
    await d.run();
    expect(d.volunteerStore.upsert).toHaveBeenCalledWith(expect.objectContaining({ qualifies: false, activityDateISO: null }), expect.any(String));
    expect(d.changeColumnValues).toHaveBeenCalledTimes(1);
  });

  it('an unlinked registrant is stored with no owner and recomputes nobody', async () => {
    const d = deps({ registration: reg({ attendeeItemId: null }) });
    await d.run();
    expect(d.volunteerStore.upsert).toHaveBeenCalledWith(expect.objectContaining({ ownerItemId: null, qualifies: false }), expect.any(String));
    expect(d.mondayClient.getItemBoardId).not.toHaveBeenCalled();
    expect(d.changeColumnValues).not.toHaveBeenCalled();
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('r1', 'written', expect.anything());
  });

  it('an Attendee re-point recomputes the new owner inline and queues the previous one (Review Focus 3)', async () => {
    const d = deps({ previousOwner: { ownerItemId: 'p0', ownerBoardId: '2' } });
    await d.run();
    expect(d.changeColumnValues.mock.calls[0]![1]).toBe('p1');
    expect(d.queue.send).toHaveBeenCalledWith({ donationItemId: 'r1', donationBoardId: '7', ownerItemId: 'p0', ownerBoardId: '2' });
    // Queued before the inline recompute writes, so a failed recompute can't lose the previous owner.
    expect(d.queue.send.mock.invocationCallOrder[0]!).toBeLessThan(d.changeColumnValues.mock.invocationCallOrder[0]!);
  });

  it('a deleted registration is marked removed and its former owner recomputed', async () => {
    const d = deps({ registration: null });
    (d.volunteerStore.markRemoved as ReturnType<typeof vi.fn>).mockResolvedValue({ ownerItemId: 'p1', ownerBoardId: '2' });
    await d.run();
    expect(d.volunteerStore.upsert).not.toHaveBeenCalled();
    expect(d.changeColumnValues.mock.calls[0]![1]).toBe('p1');
  });

  it('an attendee on a board without membership columns (Organizations) is stored but not recomputed', async () => {
    const d = deps({ ownerBoard: '3' });
    await d.run();
    expect(d.volunteerStore.upsert).toHaveBeenCalled();
    expect(d.changeColumnValues).not.toHaveBeenCalled();
  });

  it('a registration from a board outside volunteerBoards is non-retryable: marked failed and acked', async () => {
    const d = deps();
    const message = { body: { kind: 'registration' as const, donationItemId: 'r1', donationBoardId: '999' }, ack: vi.fn(), retry: vi.fn() };
    await d.run(message);
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('r1', 'failed', expect.objectContaining({ error: expect.stringContaining('volunteerBoards') }));
  });
});
