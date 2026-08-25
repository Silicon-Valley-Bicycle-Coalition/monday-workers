import type { PendingStore } from '../db/pending';
import type { DonationRollupsMondayClient } from '../monday/client';
import type { DonationRollupsConfig, OwnerColumns, RecomputeQueueMessage } from '../types';
import { computeRollup, currentFiscalYear, type Rollup } from '../rollups/compute';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface ProcessBatchDeps {
  pendingStore: PendingStore;
  mondayClient: DonationRollupsMondayClient;
  config: DonationRollupsConfig;
  now?: Date; // injectable for tests; defaults to the real current time
}

export async function processRecomputeBatch(
  messages: QueueMessageLike<RecomputeQueueMessage>[], deps: ProcessBatchDeps,
): Promise<void> {
  for (const message of messages) {
    const { donationItemId } = message.body;
    try {
      await processOne(donationItemId, deps);
      message.ack();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donation-rollups consumer: failed to process donation "${donationItemId}": ${errMsg}`);
      await deps.pendingStore.updateStatus(donationItemId, 'failed', { error: errMsg });
      message.retry();
    }
  }
}

async function processOne(donationItemId: string, deps: ProcessBatchDeps): Promise<void> {
  const { mondayClient, config } = deps;
  const { donationColumns, receivedStatusLabel, ownerColumnsByBoard } = config.donationRollups;
  const { donations: donationsBoardId, donors: donorsBoardId, organizations: orgsBoardId } = config.monday.boards;
  if (donationsBoardId === null) throw new Error('config: monday.boards.donations is not configured');

  const ownerItemId = await mondayClient.getDonorLinkForDonation(donationItemId, donationColumns.donorLink);
  if (ownerItemId === null) {
    // Legitimately nothing to recompute — an unlinked donation isn't a transient
    // failure, so this is a benign skip, not a retry candidate.
    await deps.pendingStore.updateStatus(donationItemId, 'written', { writtenAt: new Date().toISOString() });
    return;
  }

  const ownerBoardId = await mondayClient.getItemBoardId(ownerItemId);
  const ownerBoard: 'donors' | 'organizations' =
    ownerBoardId !== null && orgsBoardId !== null && Number(ownerBoardId) === orgsBoardId
      ? 'organizations' : 'donors';
  if (donorsBoardId === null) throw new Error('config: monday.boards.donors is not configured');
  const targetBoardId = ownerBoard === 'organizations' ? orgsBoardId! : donorsBoardId;

  const donations = await mondayClient.getDonationsForOwner(
    donationsBoardId, donationColumns.donorLink, ownerItemId,
    { amount: donationColumns.amount, date: donationColumns.date,
      fiscalYear: donationColumns.fiscalYear, status: donationColumns.status },
  );

  const thisFY = currentFiscalYear(deps.now ?? new Date());
  const rollup = computeRollup(donations, receivedStatusLabel, thisFY);
  const columnValues = rollupToColumnValues(rollup, ownerColumnsByBoard[ownerBoard]);

  await mondayClient.changeColumnValues(targetBoardId, ownerItemId, columnValues);

  await deps.pendingStore.updateStatus(donationItemId, 'written', {
    ownerItemId, ownerBoard, writtenAt: new Date().toISOString(),
  });
}

function numCol(n: number | null): string {
  return n === null ? '' : String(n);
}

function dateCol(iso: string | null): unknown {
  return iso === null ? null : { date: iso.slice(0, 10) };
}

export function rollupToColumnValues(r: Rollup, columns: OwnerColumns): Record<string, unknown> {
  return {
    [columns.lifetimeGiving]: numCol(r.lifetimeGiving),
    [columns.giftCount]: numCol(r.giftCount),
    [columns.firstGift]: dateCol(r.firstGiftISO),
    [columns.thisYearAmount]: numCol(r.thisYearAmount),
    [columns.thisYearCount]: numCol(r.thisYearCount),
    [columns.lastYearAmount]: numCol(r.lastYearAmount),
    [columns.lastYearCount]: numCol(r.lastYearCount),
    [columns.largestGift]: numCol(r.largestGift),
    [columns.smallestGift]: numCol(r.smallestGift),
    [columns.averageGift]: numCol(r.averageGift),
    [columns.lastGiftDate]: dateCol(r.lastGiftDate),
    [columns.lastGiftAmount]: numCol(r.lastGiftAmount),
  };
}
