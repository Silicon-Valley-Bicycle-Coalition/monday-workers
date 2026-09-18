import type { PendingStore } from '../db/pending';
import type { DonationLinksStore } from '../db/links';
import type { GiftsStore } from '../db/gifts';
import type { MembershipBaselineStore } from '../db/membershipBaseline';
import type { OwnerRecomputesStore } from '../db/ownerRecomputes';
import type { DonationRollupsMondayClient, DonationRecord } from '../monday/client';
import type {
  DonationRollupsConfig, OwnerColumns, RecomputeQueueMessage,
  DonationBoardConfig, MembershipConfig, OwnerMembershipColumns,
} from '../types';
import { computeRollup, currentFiscalYear, type Rollup } from '../rollups/compute';
import {
  buildGiftLedgerJson, buildGiftHistoryMarkdown,
  GIFT_LEDGER_ALERT_BYTES, type GiftLedgerProjection,
} from '../projections/giftHistory';
import { isD1QuotaError, secondsUntilMidnightUTC } from './quota';
import {
  deriveMembership, mergeWithBoard, statusFor, tierFromLabel,
  membershipColumnValues, termColumnValues, type MembershipState,
} from '../membership/derive';

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ProcessBatchDeps {
  pendingStore: PendingStore;
  linksStore: DonationLinksStore;
  giftsStore: GiftsStore;
  baselineStore: MembershipBaselineStore;
  recomputesStore: OwnerRecomputesStore;
  mondayClient: DonationRollupsMondayClient;
  config: DonationRollupsConfig;
  now?: Date; // injectable for tests; defaults to the real current time
}

// A failure that no amount of retrying can heal (e.g. a config mismatch): the row is
// marked failed for the operator, but the message is acked so it doesn't burn three
// retries and land in the DLQ on every future delivery for the same owner.
class NonRetryableError extends Error {}

// A first run after enabling the membership feature, or a widened eligibleGiftTypes, can leave
// dozens of unstamped gifts on one owner; each stamp is one Monday mutation and the Free plan's
// subrequest cap is 50 per invocation. The design converges (spec "Writes and idempotency"), so
// stamp the first N per recompute and let the stamped gifts' own webhooks recompute and continue.
const MAX_GIFT_TERM_WRITES_PER_RECOMPUTE = 10;

export async function processRecomputeBatch(
  messages: QueueMessageLike<RecomputeQueueMessage>[], deps: ProcessBatchDeps,
): Promise<void> {
  // Once D1 has refused a query for the day, every later message in this batch would fail the
  // same way after spending two Monday calls each — defer them all to the same moment instead.
  let quotaDelaySeconds: number | null = null;
  for (const message of messages) {
    const { donationItemId, donationBoardId } = message.body;
    if (quotaDelaySeconds !== null) {
      message.retry({ delaySeconds: quotaDelaySeconds });
      continue;
    }
    try {
      await processOne(donationItemId, donationBoardId, deps);
      message.ack();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`donation-rollups consumer: failed to process donation "${donationItemId}": ${errMsg}`);
      // This write is itself a D1 query. During a D1 outage it throws too — and until fix 4 that
      // escaped the loop, retried the whole batch immediately, and three fast retries later
      // every message was dead in the DLQ. It must never take the retry decision down with it.
      try {
        await deps.pendingStore.updateStatus(donationItemId, 'failed', { error: errMsg });
      } catch (statusErr) {
        console.error(`donation-rollups consumer: could not record failed status for donation "${donationItemId}": ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`);
      }
      if (err instanceof NonRetryableError) {
        message.ack();
      } else if (isD1QuotaError(err)) {
        // D1's daily limit resets at midnight UTC — the retry worth making is the one after it.
        quotaDelaySeconds = secondsUntilMidnightUTC(deps.now ?? new Date());
        console.error(`donation-rollups consumer: D1 daily quota exhausted — deferring this and the rest of the batch ${quotaDelaySeconds}s (to midnight UTC)`);
        message.retry({ delaySeconds: quotaDelaySeconds });
      } else {
        message.retry();
      }
    }
  }
}

async function processOne(donationItemId: string, donationBoardId: string, deps: ProcessBatchDeps): Promise<void> {
  const { mondayClient, config } = deps;
  const { donationBoards, receivedStatusLabel, ownerColumnsByBoard } = config.donationRollups;

  // Defense in depth behind the webhook route's board allowlist: anything already in the
  // queue from an unknown board is a permanent config mismatch, not a transient failure —
  // mark it failed and ack rather than retrying it into the DLQ.
  const sourceBoard = donationBoards.find((b) => String(b.boardId) === donationBoardId);
  if (sourceBoard === undefined) {
    throw new NonRetryableError(`config: no donationBoards entry for board id "${donationBoardId}" (this donation's board)`);
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
  const link = await deps.linksStore.upsertLink(
    { donationItemId, donationBoardId, ownerItemId, ownerBoardId },
    new Date().toISOString(),
  );

  // Coalescing (README "operational findings, 2026-09-17", fix 3). A bulk edit recomputes a big
  // owner once per donation; if a recompute of this owner already READ Monday at or after this
  // donation's webhook arrived, it saw this edit and there is nothing new to compute. Two parts,
  // both required: (1) the owner's last fetch is at/after the pending row's received_at —
  // fetch time, not completion, since a recompute that started before the edit read stale
  // data; (2) this donation's link already existed, unchanged, before that fetch — a recompute
  // only reads the donations D1 links to the owner at that moment, so a new or re-owned link
  // (or one rewritten after the fetch) can't have been covered. No pending row (a custodian
  // sweep message) or no prior recompute means recompute.
  const [last, pending] = await Promise.all([
    deps.recomputesStore.get(ownerItemId),
    deps.pendingStore.getPending(donationItemId),
  ]);
  if (last !== null && pending !== null
    && last.fetchedAt >= pending.receivedAt
    && !link.changed && link.updatedAt <= last.fetchedAt) {
    console.log(`donation-rollups consumer: coalesced donation "${donationItemId}" — owner ${ownerItemId} already fetched at ${last.fetchedAt}, after its webhook at ${pending.receivedAt}`);
    await deps.pendingStore.updateStatus(donationItemId, 'written', {
      ownerItemId, ownerBoard: ownerBoardId, writtenAt: new Date().toISOString(),
    });
    return;
  }
  const fetchedAt = new Date().toISOString();

  // Monday has no supported filter for board_relation columns (confirmed 2026-08-24 —
  // items_page_by_column_values rejects it outright), so "every Donation this owner
  // has" comes from the D1 reverse index, not a live Monday query. getDonationsByIds
  // then fetches those specific items directly, grouped by board since column ids
  // differ per Donations era board.
  const linksByBoard = await deps.linksStore.getLinksForOwner(ownerItemId);
  const perBoard = await Promise.all(donationBoards
    .filter((b) => linksByBoard.has(String(b.boardId)))
    .map(async (b) => ({ board: b, items: await mondayClient.getDonationsByIds(linksByBoard.get(String(b.boardId))!, b.columns) })));
  const donations = perBoard.flatMap((p) => p.items);

  // Ledger v2 (docs/20 §5.1): every recompute re-asserts the webhook-visible facts of every
  // gift it just read, so the gifts table self-heals from the same fetch the rollup uses —
  // a missed webhook can't leave the ledger stale past this owner's next recompute. The store
  // diffs before writing, so an owner whose history is already right costs no D1 rows written
  // (the 09-03/09-09 floods rewrote big owners' whole histories dozens of times each).
  const refreshed = await deps.giftsStore.refreshFacts(
    donations.map((d) => ({
      mondayItemId: d.id, ownerItemId, ownerBoardId,
      amountCents: Math.round(d.amount * 100),
      giftDateISO: d.dateISO, fiscalYear: d.fiscalYear, status: d.status,
      giftType: d.giftType ?? null,
    })),
    'webhook', new Date().toISOString());
  if (refreshed.changed > 0) {
    console.log(`donation-rollups consumer: owner ${ownerItemId}: ${refreshed.changed} of ${donations.length} gift facts changed`);
  }

  const thisFY = currentFiscalYear(deps.now ?? new Date());
  const rollup = computeRollup(donations, receivedStatusLabel, thisFY);

  // Membership renewal write path (spec 2026-09-15): only for owners on a board with the four
  // membership columns, and only when the feature block is configured. Organizations and a
  // null block both skip silently — neither is a fault.
  const membership = config.donationRollups.membership;
  const membershipColumns = ownerColumns.membership;
  let membershipValues: Record<string, unknown> = {};
  const giftTermWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] = [];
  if (membership !== null && membershipColumns !== undefined) {
    const step = await planMembershipWrites(deps, ownerItemId, ownerBoardId, membershipColumns, membership, perBoard);
    membershipValues = step.ownerValues;
    giftTermWrites.push(...step.giftWrites);
  }

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
    ...membershipValues,
  };

  await mondayClient.changeColumnValues(Number(ownerBoardId), ownerItemId, columnValues);
  // Gift term columns, owner first (spec §"Writes and idempotency"): if one of these fails the
  // owner is already right and the retry re-derives the missing stamps. Each write fires this
  // Worker's own webhook; the resulting recompute finds nothing changed and writes nothing.
  for (const w of giftTermWrites) {
    await mondayClient.changeColumnValues(w.boardId, w.itemId, w.values);
  }
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

  // Recorded only now — after the owner write AND the gift term stamps — so a recompute that
  // failed partway is retried in full rather than coalesced away (the retry's webhook time
  // predates this fetch; without a fresh row it can't match). The description write above is
  // non-fatal and deliberately doesn't gate this.
  await deps.recomputesStore.record({ ownerItemId, ownerBoardId, fetchedAt, writtenAt: new Date().toISOString() });
  await deps.pendingStore.updateStatus(donationItemId, 'written', {
    ownerItemId, ownerBoard: ownerBoardId, writtenAt: new Date().toISOString(),
  });
}

async function planMembershipWrites(
  deps: ProcessBatchDeps, ownerItemId: string, ownerBoardId: string,
  columns: OwnerMembershipColumns, membership: MembershipConfig,
  perBoard: { board: DonationBoardConfig; items: DonationRecord[] }[],
): Promise<{ ownerValues: Record<string, unknown>; giftWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] }> {
  const { mondayClient, baselineStore, config } = deps;
  const board = await mondayClient.getOwnerMembership(ownerItemId, columns);
  const boardState: MembershipState = { since: board.since, until: board.until, tier: tierFromLabel(board.tierLabel, membership) };

  // Captured before this Worker's first membership write to the owner — by construction,
  // since the capture happens on the same recompute that would make that write.
  const baseline = (await baselineStore.get(ownerItemId))
    ?? (await baselineStore.captureIfAbsent({ ownerItemId, ownerBoardId, ...boardState, capturedAt: new Date().toISOString() }));

  const gifts = perBoard.flatMap((p) => p.items.map((d) => ({
    id: d.id, dateISO: d.dateISO, amountCents: Math.round(d.amount * 100), status: d.status, giftType: d.giftType ?? null,
  })));
  const derived = deriveMembership({ since: baseline.since, until: baseline.until, tier: baseline.tier },
    gifts, membership, config.donationRollups.receivedStatusLabel);
  // The rule is about gifts creating or extending terms: an owner touched only by an unrelated
  // Donations edit (or one whose only gifts are ineligible) must not have Status rewritten or a
  // hand-set Until cleared — Status on the calendar is the native automation's job, not ours.
  if (derived.terms.size === 0) return { ownerValues: {}, giftWrites: [] };
  const merged = mergeWithBoard(derived.state, boardState);
  const todayISO = (deps.now ?? new Date()).toISOString().slice(0, 10);
  const ownerValues = membershipColumnValues(merged, statusFor(merged, todayISO),
    { ...boardState, statusLabel: board.statusLabel }, columns, membership);

  // Fold order — sort by dateISO then id, same comparator deriveMembership uses — so a capped
  // batch always stamps the oldest gifts first, matching the order the state was folded in.
  const candidates = perBoard.flatMap(({ board: b, items }) => {
    const cols = b.columns;
    if (!cols.termStart || !cols.termEnd || !cols.membershipType) return []; // validated present when membership is on
    return items.map((d) => ({ board: b, d, cols: { termStart: cols.termStart!, termEnd: cols.termEnd!, membershipType: cols.membershipType! } }));
  }).sort((a, b) => (a.d.dateISO < b.d.dateISO ? -1 : a.d.dateISO > b.d.dateISO ? 1
    : a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0));

  const giftWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] = [];
  for (const { board: b, d, cols } of candidates) {
    const values = termColumnValues(derived.terms.get(d.id),
      { termStart: d.termStart ?? null, termEnd: d.termEnd ?? null, membershipType: d.membershipType ?? null },
      cols, membership);
    if (Object.keys(values).length > 0) giftWrites.push({ boardId: b.boardId, itemId: d.id, values });
  }
  if (giftWrites.length > MAX_GIFT_TERM_WRITES_PER_RECOMPUTE) {
    const remaining = giftWrites.length - MAX_GIFT_TERM_WRITES_PER_RECOMPUTE;
    console.log(`donation-rollups: owner ${ownerItemId} has ${remaining} more gift term stamps pending; continuing on the next recompute`);
    giftWrites.length = MAX_GIFT_TERM_WRITES_PER_RECOMPUTE;
  }
  return { ownerValues, giftWrites };
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
