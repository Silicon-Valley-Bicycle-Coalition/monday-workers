import type { PendingStore } from '../db/pending';
import type { DonationLinksStore } from '../db/links';
import type { GiftsStore } from '../db/gifts';
import type { DonationRollupsMondayClient } from '../monday/client';
import type { DonationRollupsConfig, OwnerColumns, RecomputeQueueMessage } from '../types';
import { computeRollup, currentFiscalYear, type Rollup } from '../rollups/compute';
import {
  buildGiftLedgerJson, buildGiftHistoryMarkdown,
  GIFT_LEDGER_ALERT_BYTES, type GiftLedgerProjection,
} from '../projections/giftHistory';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface ProcessBatchDeps {
  pendingStore: PendingStore;
  linksStore: DonationLinksStore;
  giftsStore: GiftsStore;
  mondayClient: DonationRollupsMondayClient;
  config: DonationRollupsConfig;
  now?: Date; // injectable for tests; defaults to the real current time
}

export async function processRecomputeBatch(
  messages: QueueMessageLike<RecomputeQueueMessage>[], deps: ProcessBatchDeps,
): Promise<void> {
  for (const message of messages) {
    const { donationItemId, donationBoardId } = message.body;
    try {
      await processOne(donationItemId, donationBoardId, deps);
      message.ack();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donation-rollups consumer: failed to process donation "${donationItemId}": ${errMsg}`);
      await deps.pendingStore.updateStatus(donationItemId, 'failed', { error: errMsg });
      message.retry();
    }
  }
}

async function processOne(donationItemId: string, donationBoardId: string, deps: ProcessBatchDeps): Promise<void> {
  const { mondayClient, config } = deps;
  const { donationBoards, receivedStatusLabel, ownerColumnsByBoard } = config.donationRollups;

  const sourceBoard = donationBoards.find((b) => String(b.boardId) === donationBoardId);
  if (sourceBoard === undefined) {
    throw new Error(`config: no donationBoards entry for board id "${donationBoardId}" (this donation's board)`);
  }

  let ownerItemId = await mondayClient.getDonorLinkForDonation(donationItemId, sourceBoard.columns.donorLink);
  if (ownerItemId === null) {
    // An archived item's board_relation reads back empty (see projections/giftHistory.ts),
    // and the July sweep's representative gift per owner is often archived — before
    // concluding there's nothing to recompute, fall back to the owner D1 already knows
    // for this donation so lapsed donors still get their fiscal-year rollover.
    ownerItemId = (await deps.linksStore.getLinkForDonation(donationItemId))?.ownerItemId ?? null;
  }
  if (ownerItemId === null) {
    // Legitimately nothing to recompute — a donation unlinked on Monday AND unknown to
    // D1 isn't a transient failure, so this is a benign skip, not a retry candidate.
    await deps.pendingStore.updateStatus(donationItemId, 'written', { writtenAt: new Date().toISOString() });
    return;
  }

  const ownerBoardId = await mondayClient.getItemBoardId(ownerItemId);
  if (ownerBoardId === null) {
    throw new Error(`owner item "${ownerItemId}" has no resolvable board (deleted between link and lookup?)`);
  }
  const ownerColumns = ownerColumnsByBoard[ownerBoardId];
  if (ownerColumns === undefined) {
    throw new Error(`config: no ownerColumnsByBoard entry for board id "${ownerBoardId}" (this owner's board)`);
  }

  // Keep the reverse index current *before* reading it back — this donation's own
  // link is part of what the recompute below needs to see.
  await deps.linksStore.upsertLink(
    { donationItemId, donationBoardId, ownerItemId, ownerBoardId },
    new Date().toISOString(),
  );

  // Monday has no supported filter for board_relation columns (confirmed 2026-08-24 —
  // items_page_by_column_values rejects it outright), so "every Donation this owner
  // has" comes from the D1 reverse index, not a live Monday query. getDonationsByIds
  // then fetches those specific items directly, grouped by board since column ids
  // differ per Donations era board.
  const linksByBoard = await deps.linksStore.getLinksForOwner(ownerItemId);
  const perBoard = await Promise.all(donationBoards
    .filter((b) => linksByBoard.has(String(b.boardId)))
    .map((b) => mondayClient.getDonationsByIds(linksByBoard.get(String(b.boardId))!, b.columns)));
  const donations = perBoard.flat();

  // Ledger v2 (docs/20 §5.1): every recompute re-asserts the webhook-visible facts of every
  // gift it just read, so the gifts table self-heals from the same fetch the rollup uses —
  // a missed webhook can't leave the ledger stale past this owner's next recompute.
  await deps.giftsStore.refreshFacts(
    donations.map((d) => ({
      mondayItemId: d.id, ownerItemId, ownerBoardId,
      amountCents: Math.round(d.amount * 100),
      giftDateISO: d.dateISO, fiscalYear: d.fiscalYear, status: d.status,
      giftType: d.giftType ?? null,
    })),
    'webhook', new Date().toISOString());

  const thisFY = currentFiscalYear(deps.now ?? new Date());
  const rollup = computeRollup(donations, receivedStatusLabel, thisFY);

  // Gift-history projections (docs/20 §5.5) ride the same write: the JSON column goes into
  // the one change_multiple_column_values call, the markdown description is its own call.
  // Sourced from the ledger (not the Monday fetch) — it carries gift types and archived
  // state for the full history, including gifts archived long before this webhook.
  const history = await deps.giftsStore.giftsForOwner(ownerItemId);
  const ledgerProjection = buildGiftLedgerJson(history);
  // Docs/20 §5.5: overflow is a planned decision, never a surprise truncation — alert the
  // moment a projection crosses the planning threshold (48KB), and past the hard write
  // budget (~60KB) write the truncated form rather than letting the one combined column
  // write throw, exhaust queue retries, and permanently DLQ every future gift for this
  // owner. The full history stays in D1 either way.
  if (ledgerProjection.fullBytes > GIFT_LEDGER_ALERT_BYTES) {
    await alertOversizedLedger(deps, ownerItemId, ledgerProjection);
  }
  const columnValues = {
    ...rollupToColumnValues(rollup, ownerColumns),
    [ownerColumns.giftLedgerJson]: ledgerProjection.json,
  };

  await mondayClient.changeColumnValues(Number(ownerBoardId), ownerItemId, columnValues);
  try {
    await mondayClient.setItemDescription(ownerItemId,
      buildGiftHistoryMarkdown(history, deps.config.monday.accountUrl));
  } catch (err) {
    // Non-fatal by design: the markdown description is a redundant human rendering of the
    // Gift Ledger JSON column, and set_item_description_content 500s outright on accounts
    // where the item-description feature isn't enabled (observed live 2026-08-31 — even a
    // trivial markdown fails). The rollups and JSON projection above already landed; don't
    // burn queue retries over the optional rendering.
    console.warn(`donation-rollups consumer: gift-history description skipped for owner "${ownerItemId}": ${err instanceof Error ? err.message : String(err)}`);
  }

  await deps.pendingStore.updateStatus(donationItemId, 'written', {
    ownerItemId, ownerBoard: ownerBoardId, writtenAt: new Date().toISOString(),
  });
}

// Same alerting path as the custodian's failed duties (custodian/custodian.ts alert()):
// console.error always, plus a Monday update on custodian.alertItemId when configured.
// Nothing here may throw — the rollup write must land whether or not the alert posts.
async function alertOversizedLedger(
  deps: ProcessBatchDeps, ownerItemId: string, ledger: GiftLedgerProjection,
): Promise<void> {
  const message =
    `donation-rollups: Gift Ledger JSON for owner ${ownerItemId} is ${ledger.fullBytes} bytes ` +
    `(${ledger.totalCount} gifts), past the ${GIFT_LEDGER_ALERT_BYTES}-byte planning threshold (docs/20 §5.5). ` +
    (ledger.truncated
      ? `Wrote the ${ledger.includedCount} most recent gifts plus a truncation marker; the full history remains in D1.`
      : `Still written in full — plan the projection split before it reaches Monday's ~64KB item budget.`);
  console.error(message);
  const { alertItemId } = deps.config.custodian;
  if (alertItemId === null) return;
  try {
    await deps.mondayClient.createUpdate(alertItemId, message);
  } catch (err) {
    console.error(`donation-rollups: posting oversized-ledger alert to Monday item ${alertItemId} failed: ${String(err)}`);
  }
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
