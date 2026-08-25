import { describe, it, expect, vi } from 'vitest';
import { processRecomputeBatch, rollupToColumnValues } from './processBatch';
import type { PendingStore } from '../db/pending';
import type { DonationRollupsMondayClient, DonationRecord } from '../monday/client';
import type { DonationRollupsConfig, OwnerColumns } from '../types';

const ownerColumns: OwnerColumns = {
  lifetimeGiving: 'lg', giftCount: 'gc', firstGift: 'fg',
  thisYearAmount: 'tya', thisYearCount: 'tyc', lastYearAmount: 'lya', lastYearCount: 'lyc',
  largestGift: 'lag', smallestGift: 'smg', averageGift: 'avg',
  lastGiftDate: 'lgd', lastGiftAmount: 'lga',
};

const config: DonationRollupsConfig = {
  monday: { apiUrl: 'https://api.monday.com/v2', boards: { donations: 1, donors: 2, organizations: 3 } },
  donationRollups: {
    donationColumns: { donorLink: 'donor_link', amount: 'amount', date: 'date', fiscalYear: 'fy', status: 'status' },
    receivedStatusLabel: 'Received',
    ownerColumnsByBoard: { donors: ownerColumns, organizations: ownerColumns },
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

function fakeMessage(donationItemId: string) {
  return { body: { donationItemId }, ack: vi.fn(), retry: vi.fn() };
}

function fakeMondayClient(overrides: Partial<DonationRollupsMondayClient> = {}): DonationRollupsMondayClient {
  return {
    getItemBoardId: vi.fn().mockResolvedValue('2'),
    getDonorLinkForDonation: vi.fn().mockResolvedValue('donor-1'),
    getDonationsForOwner: vi.fn().mockResolvedValue([]),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

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
  it('recomputes and writes to the Donor board when the owner is a Donor', async () => {
    const donations: DonationRecord[] = [
      { id: 'd1', amount: 100, dateISO: '2025-08-01', fiscalYear: 2026, status: 'Received' },
    ];
    const mondayClient = fakeMondayClient({
      getItemBoardId: vi.fn().mockResolvedValue('2'), // matches config.monday.boards.donors
      getDonationsForOwner: vi.fn().mockResolvedValue(donations),
    });
    const pendingStore = fakePendingStore();

    await processRecomputeBatch([fakeMessage('dn1')], { pendingStore, mondayClient, config, now: new Date('2026-01-01') });

    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(2, 'donor-1', expect.objectContaining({ lg: '100' }));
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'written',
      expect.objectContaining({ ownerItemId: 'donor-1', ownerBoard: 'donors' }));
  });

  it('writes to the Organizations board when the owner item lives there instead', async () => {
    const mondayClient = fakeMondayClient({ getItemBoardId: vi.fn().mockResolvedValue('3') }); // matches organizations
    const pendingStore = fakePendingStore();

    await processRecomputeBatch([fakeMessage('dn2')], { pendingStore, mondayClient, config });

    expect(mondayClient.changeColumnValues).toHaveBeenCalledWith(3, 'donor-1', expect.anything());
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn2', 'written',
      expect.objectContaining({ ownerBoard: 'organizations' }));
  });

  it('skips cleanly (no retry) when the donation has no linked owner', async () => {
    const mondayClient = fakeMondayClient({ getDonorLinkForDonation: vi.fn().mockResolvedValue(null) });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn3');

    await processRecomputeBatch([message], { pendingStore, mondayClient, config });

    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn3', 'written', expect.anything());
  });

  it('retries and marks failed on a Monday API error, does not ack', async () => {
    const mondayClient = fakeMondayClient({
      changeColumnValues: vi.fn().mockRejectedValue(new Error('monday API: HTTP 500')),
    });
    const pendingStore = fakePendingStore();
    const message = fakeMessage('dn4');

    await processRecomputeBatch([message], { pendingStore, mondayClient, config });

    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(pendingStore.updateStatus).toHaveBeenCalledWith('dn4', 'failed', { error: 'monday API: HTTP 500' });
  });
});
