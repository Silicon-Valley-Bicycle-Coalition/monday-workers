import type { PendingStore } from '../db/pending';
import type { DonationLinksStore } from '../db/links';
import type { GiftsStore } from '../db/gifts';
import type { MembershipBaselineStore } from '../db/membershipBaseline';
import type { OwnerRecomputesStore } from '../db/ownerRecomputes';
import type { AffiliationsStore } from '../db/affiliations';
import type { DonationRollupsMondayClient, DonationRecord } from '../monday/client';
import { MondayRateLimitError } from '../monday/client';
import type {
  AffiliationsConfig, DonationRollupsConfig, OwnerColumns, RecomputeQueueMessage,
  DonationBoardConfig, MembershipConfig, OwnerMembershipColumns,
} from '../types';
import { computeRollup, currentFiscalYear, type Rollup } from '../rollups/compute';
import {
  buildGiftLedgerJson, buildGiftHistoryMarkdown,
  GIFT_LEDGER_ALERT_BYTES, type GiftLedgerProjection,
} from '../projections/giftHistory';
import { isD1QuotaError, secondsUntilMidnightUTC, rateLimitRetryDelaySeconds } from './quota';
import {
  deriveMembership, mergeWithBoard, statusFor, tierFromLabel,
  membershipColumnValues, termColumnValues, type MembershipState,
} from '../membership/derive';
import { attributedRollupFromTotals, attributedToColumnValues, organizationalGivingColumnValue } from '../rollups/attributed';
import { formatCents } from '../money';

export interface QueueMessageLike<T> {
  body: T;
  // When the message was sent (Cloudflare's Message.timestamp) — the dead-letter consumer
  // compares it against a pending row's written_at to spot stale dead messages.
  timestamp?: Date;
  // Delivery attempt, 1 on first delivery (Cloudflare's Message.attempts) — drives the
  // rate-limit backoff. Optional so test doubles needn't set it.
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ProcessBatchDeps {
  pendingStore: PendingStore;
  linksStore: DonationLinksStore;
  giftsStore: GiftsStore;
  baselineStore: MembershipBaselineStore;
  recomputesStore: OwnerRecomputesStore;
  affiliationsStore: AffiliationsStore;
  mondayClient: DonationRollupsMondayClient;
  config: DonationRollupsConfig;
  // For the owner a moved gift left (issue #26). Optional so tests and forks without it still
  // run; production wires RECOMPUTE_QUEUE in index.ts.
  queue?: { send(message: RecomputeQueueMessage): Promise<void> };
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
  // Once D1 has refused a query for the day, or Monday has said the token's budget is spent,
  // every later message in this batch would fail the same way after spending Monday calls of
  // its own — defer them all to the same moment instead.
  let batchDelaySeconds: number | null = null;
  for (const message of messages) {
    const { donationItemId, donationBoardId } = message.body;
    if (batchDelaySeconds !== null) {
      message.retry({ delaySeconds: batchDelaySeconds });
      continue;
    }
    try {
      await processOne(message.body, deps);
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
        batchDelaySeconds = secondsUntilMidnightUTC(deps.now ?? new Date());
        console.error(`donation-rollups consumer: D1 daily quota exhausted — deferring this and the rest of the batch ${batchDelaySeconds}s (to midnight UTC)`);
        message.retry({ delaySeconds: batchDelaySeconds });
      } else if (err instanceof MondayRateLimitError) {
        // Issue #27: retrying straight back into an exhausted complexity budget just burns the
        // message's retries into the DLQ. Wait out Monday's hint, backing off per attempt.
        batchDelaySeconds = rateLimitRetryDelaySeconds(err.retryInSeconds, message.attempts);
        console.error(`donation-rollups consumer: Monday rate limit (retry hint ${err.retryInSeconds ?? 'none'}s, attempt ${message.attempts ?? '?'}) — deferring this and the rest of the batch ${batchDelaySeconds}s`);
        message.retry({ delaySeconds: batchDelaySeconds });
      } else {
        message.retry();
      }
    }
  }
}

async function processOne(message: RecomputeQueueMessage, deps: ProcessBatchDeps): Promise<void> {
  const { donationItemId, donationBoardId } = message;
  const { mondayClient, config } = deps;
  const { donationBoards } = config.donationRollups;

  // An owner-keyed message: a gift moved away from this owner (issue #26). Recompute it
  // unconditionally — its totals still include the gift until it does.
  if (message.ownerItemId !== undefined && message.ownerBoardId !== undefined) {
    await recomputeOwner(deps, message.ownerItemId, message.ownerBoardId, donationItemId);
    return;
  }

  // Defense in depth behind the webhook route's board allowlist: anything already in the
  // queue from an unknown board is a permanent config mismatch, not a transient failure —
  // mark it failed and ack rather than retrying it into the DLQ.
  const sourceBoard = donationBoards.find((b) => String(b.boardId) === donationBoardId);
  if (sourceBoard === undefined) {
    throw new NonRetryableError(`config: no donationBoards entry for board id "${donationBoardId}" (this donation's board)`);
  }

  let ownerItemId = await mondayClient.getDonorLinkForDonation(donationItemId, sourceBoard.columns.donorLink);
  if (ownerItemId === null) {
    // An empty link means one of three things (issue #26), and only one of them keeps the gift
    // on its owner. An archived item's board_relation reads back empty (see
    // projections/giftHistory.ts), and the July sweep's representative gift per owner is often
    // archived — fall back to the owner D1 already knows so lapsed donors still get their
    // fiscal-year rollover. A deleted item, or an active one whose link staff cleared, no longer
    // counts for anyone: detach it and recompute the owner it left.
    const state = await mondayClient.getDonationState(donationItemId);
    if (state !== 'archived') {
      await detachDonation(deps, donationItemId, state);
      await deps.pendingStore.updateStatus(donationItemId, 'written', { writtenAt: new Date().toISOString() });
      return;
    }
    ownerItemId = (await deps.linksStore.getLinkForDonation(donationItemId))?.ownerItemId ?? null;
  }
  if (ownerItemId === null) {
    // Legitimately nothing to recompute — an archived donation unknown to D1 isn't a transient
    // failure, so this is a benign skip, not a retry candidate.
    await deps.pendingStore.updateStatus(donationItemId, 'written', { writtenAt: new Date().toISOString() });
    return;
  }

  const ownerBoardId = await mondayClient.getItemBoardId(ownerItemId);
  if (ownerBoardId === null) {
    throw new Error(`owner item "${ownerItemId}" has no resolvable board (deleted between link and lookup?)`);
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

  await recomputeOwner(deps, ownerItemId, ownerBoardId, donationItemId);

  // The gift moved here from another owner (issue #26): that owner's totals still include it.
  // Queued rather than recomputed inline — a second full recompute in this invocation would
  // blow the per-invocation subrequest budget max_batch_size=2 is tuned for.
  if (link.previousOwner !== undefined) {
    await enqueueOwnerRecompute(deps, message, link.previousOwner);
  }

  await deps.pendingStore.updateStatus(donationItemId, 'written', {
    ownerItemId, ownerBoard: ownerBoardId, writtenAt: new Date().toISOString(),
  });
}

// Issue #26: a deleted donation, or an active one whose Donor link was cleared, must stop counting
// toward the owner D1 last linked it to. Drop the link, take the gift out of the ledger's totals
// (soft — a restore or re-link brings it back on its next recompute), then recompute that owner
// here: this message has no other recompute to do, so it costs no more than a normal one.
async function detachDonation(deps: ProcessBatchDeps, donationItemId: string, state: 'active' | 'deleted'): Promise<void> {
  const link = await deps.linksStore.getLinkForDonation(donationItemId);
  const removed = await deps.giftsStore.markRemoved(donationItemId, new Date().toISOString());
  await deps.linksStore.deleteLink(donationItemId);
  const previous = link ?? (removed === null ? null : { ownerItemId: removed.ownerItemId, ownerBoardId: removed.ownerBoardId });
  if (previous === null) return; // never linked to anyone D1 knows — nothing to recompute
  console.log(`donation-rollups consumer: donation "${donationItemId}" ${state === 'deleted' ? 'was deleted' : 'lost its Donor link'} — recomputing former owner ${previous.ownerItemId}`);
  const extraAffiliations = new Set<string>();
  if (removed?.actingForItemId) extraAffiliations.add(removed.actingForItemId);
  await recomputeOwner(deps, previous.ownerItemId, previous.ownerBoardId, donationItemId, extraAffiliations);
}

async function enqueueOwnerRecompute(
  deps: ProcessBatchDeps, message: RecomputeQueueMessage, owner: { ownerItemId: string; ownerBoardId: string },
): Promise<void> {
  if (deps.queue === undefined) {
    console.warn(`donation-rollups consumer: donation "${message.donationItemId}" moved off owner ${owner.ownerItemId} but no queue is wired — its totals stay stale until its next recompute (reconcile will flag it)`);
    return;
  }
  await deps.queue.send({ donationItemId: message.donationItemId, donationBoardId: message.donationBoardId,
    ownerItemId: owner.ownerItemId, ownerBoardId: owner.ownerBoardId });
}

// Full recompute of one owner from the D1 reverse index + a fresh Monday read: rollups, ledger
// refresh, membership, gift-history projections, affiliations. triggeringDonationId feeds the
// affiliation fan-out; extraAffiliations adds ones a detached gift was attributed to (it's no
// longer among the fetched donations, so affectedAffiliations can't see it).
async function recomputeOwner(
  deps: ProcessBatchDeps, ownerItemId: string, ownerBoardId: string, donationItemId: string,
  extraAffiliations: Set<string> = new Set(),
): Promise<void> {
  const { mondayClient, config } = deps;
  const { donationBoards, receivedStatusLabel, ownerColumnsByBoard } = config.donationRollups;
  const ownerColumns = ownerColumnsByBoard[ownerBoardId];
  if (ownerColumns === undefined) {
    throw new Error(`config: no ownerColumnsByBoard entry for board id "${ownerBoardId}" (this owner's board)`);
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
    .map(async (b) => ({ board: b, items: await mondayClient.getDonationsByIds(linksByBoard.get(String(b.boardId))!, b.columns, config.fiscalYear.startMonth) })));
  const donations = perBoard.flatMap((p) => p.items);

  // Affiliations phase 2 (spec "Rollups"): capture the ledger's acting_for *before* this
  // fetch overwrites it, so a gift that moved to a different affiliation still recomputes
  // the one it left — see affectedAffiliations below.
  const affiliationsCfg = config.affiliations;
  const fetchedIds = donations.map((d) => d.id);
  const previousActingFor = affiliationsCfg ? await deps.giftsStore.actingForByIds(fetchedIds) : new Map<string, string | null>();

  // Ledger v2 (docs/20 §5.1): every recompute re-asserts the webhook-visible facts of every
  // gift it just read, so the gifts table self-heals from the same fetch the rollup uses —
  // a missed webhook can't leave the ledger stale past this owner's next recompute. The store
  // diffs before writing, so an owner whose history is already right costs no D1 rows written
  // (the 09-03/09-09 floods rewrote big owners' whole histories dozens of times each).
  const refreshed = await deps.giftsStore.refreshFacts(
    donations.map((d) => ({
      mondayItemId: d.id, ownerItemId, ownerBoardId,
      amountCents: d.amountCents,
      giftDateISO: d.dateISO, fiscalYear: d.fiscalYear, status: d.status,
      giftType: d.giftType ?? null,
      actingForItemId: d.actingForItemId,   // undefined when no actingForLink is configured
    })),
    'webhook', new Date().toISOString());
  if (refreshed.changed > 0) {
    console.log(`donation-rollups consumer: owner ${ownerItemId}: ${refreshed.changed} of ${donations.length} gift facts changed`);
  }

  const thisFY = currentFiscalYear(deps.now ?? new Date(), config.fiscalYear);
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
  // Gift-history's own "Driven for organizations" section (docs/20 §5.5 addendum): when this
  // owner is a Person who drives giving for one or more organizations, show what their acting-for
  // attribution has produced — sourced fresh from the ledger, same as the rest of this projection.
  // Gated on affiliations being configured at all; a zero-total affiliation is omitted, not
  // shown as a $0 row.
  // Review finding 12: driven-for-organizations gets its own try, separate from the
  // description write below — a D1 hiccup computing it must not cost the whole gift-history
  // markdown (the description write has its own non-fatal handling for its own failure modes).
  let driven: { affiliationName: string; cents: number; count: number }[] | undefined;
  if (affiliationsCfg !== null) {
    try {
      driven = await drivenForOrganizations(deps, ownerItemId, receivedStatusLabel);
    } catch (err) {
      console.warn(`donation-rollups consumer: driven-for-organizations skipped for owner "${ownerItemId}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    await mondayClient.setItemDescription(ownerItemId,
      buildGiftHistoryMarkdown(history, deps.config.monday.accountUrl, driven));
  } catch (err) {
    // Non-fatal by design: the markdown description is a redundant human rendering of the
    // Gift Ledger JSON column, and set_item_description_content 500s outright on accounts
    // where the item-description feature isn't enabled (observed live 2026-08-31 — even a
    // trivial markdown fails). The rollups and JSON projection above already landed; don't
    // burn queue retries over the optional rendering.
    console.warn(`donation-rollups consumer: gift-history description skipped for owner "${ownerItemId}": ${err instanceof Error ? err.message : String(err)}`);
  }

  if (affiliationsCfg !== null) {
    const affected = affectedAffiliations(previousActingFor, donations, donationItemId);
    for (const a of extraAffiliations) affected.add(a);
    await recomputeAffiliations(deps, affiliationsCfg, affected);
  }

  // Recorded only now — after the owner write AND the gift term stamps — so a recompute that
  // failed partway is retried in full rather than coalesced away (the retry's webhook time
  // predates this fetch; without a fresh row it can't match). The description write above is
  // non-fatal and deliberately doesn't gate this.
  await deps.recomputesStore.record({ ownerItemId, ownerBoardId, fetchedAt, writtenAt: new Date().toISOString() });
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
    id: d.id, dateISO: d.dateISO, amountCents: d.amountCents, status: d.status, giftType: d.giftType ?? null,
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

async function drivenForOrganizations(
  deps: ProcessBatchDeps, ownerItemId: string, statusLabel: string,
): Promise<{ affiliationName: string; cents: number; count: number }[]> {
  const mine = await deps.affiliationsStore.forPerson(ownerItemId);
  const driven: { affiliationName: string; cents: number; count: number }[] = [];
  for (const a of mine) {
    const totals = await deps.giftsStore.attributedTotals(a.affiliationItemId, statusLabel);
    if (totals.cents > 0) driven.push({ affiliationName: a.name, cents: totals.cents, count: totals.count });
  }
  return driven;
}

function countCol(n: number): string {
  return String(n);
}

// Integer cents -> "714.93"; null (no received gifts) -> a blank cell.
function moneyCol(cents: number | null): string {
  return cents === null ? '' : formatCents(cents);
}

function dateCol(iso: string | null): unknown {
  return iso === null ? null : { date: iso.slice(0, 10) };
}

export function rollupToColumnValues(r: Rollup, columns: OwnerColumns): Record<string, unknown> {
  return {
    [columns.lifetimeGiving]: moneyCol(r.lifetimeGivingCents),
    [columns.giftCount]: countCol(r.giftCount),
    [columns.firstGift]: dateCol(r.firstGiftISO),
    [columns.thisYearAmount]: moneyCol(r.thisYearCents),
    [columns.thisYearCount]: countCol(r.thisYearCount),
    [columns.lastYearAmount]: moneyCol(r.lastYearCents),
    [columns.lastYearCount]: countCol(r.lastYearCount),
    [columns.largestGift]: moneyCol(r.largestGiftCents),
    [columns.smallestGift]: moneyCol(r.smallestGiftCents),
    [columns.averageGift]: moneyCol(r.averageGiftCents),
    [columns.lastGiftDate]: dateCol(r.lastGiftDate),
    [columns.lastGiftAmount]: moneyCol(r.lastGiftCents),
  };
}

// Bounded fan-out (review finding 1): only the triggering gift and gifts whose acting_for
// actually changed contribute affiliations to recompute — not every gift this owner has, which
// for an organization owner holding all attributed gifts (the common case after the Donor-link
// decision) would be unbounded amplification against Monday's per-invocation subrequest budget.
export function affectedAffiliations(
  previous: Map<string, string | null>, donations: DonationRecord[], triggeringDonationId: string,
): Set<string> {
  const out = new Set<string>();
  const add = (v: string | null | undefined) => { if (v) out.add(v); };
  for (const d of donations) {
    const previousActingFor = previous.get(d.id) ?? null;
    const currentActingFor = d.actingForItemId ?? null;
    if (d.id === triggeringDonationId) {
      add(previousActingFor);
      add(currentActingFor);
    } else if (currentActingFor !== null && previousActingFor !== currentActingFor) {
      // Review finding 1: a null CURRENT value on a non-triggering gift is Monday reading an
      // archived item's board_relation as empty, not a real clear — D1 preserves the archived
      // gift's acting_for_item_id forever, so without this guard previous !== current would
      // fire on every recompute for every archived attributed gift this owner ever had,
      // fanning out to every affiliation across the owner's full tenure history. A genuine
      // clear on the TRIGGERING gift (the one just written) is still caught above.
      add(previousActingFor);
      add(currentActingFor);
    }
  }
  return out;
}

// Phase 2 (spec "Rollups"): the affiliations this batch of gifts touches get their attributed
// totals rewritten, and every person those affiliations belong to — now, or before a re-point —
// gets Organizational Giving rewritten. Full recompute from the ledger, like phase 1.
async function recomputeAffiliations(deps: ProcessBatchDeps, cfg: AffiliationsConfig, affiliationIds: Set<string>): Promise<void> {
  const { mondayClient, giftsStore, affiliationsStore, config } = deps;
  const { receivedStatusLabel, ownerColumnsByBoard } = config.donationRollups;
  const now = new Date().toISOString();
  const persons = new Map<string, string>(); // person item id -> board id, from a fresh Monday summary
  const previousPersons = new Map<string, string>(); // person item id -> board id, from a (possibly stale) D1 row
  for (const affiliationId of affiliationIds) {
    const previous = await affiliationsStore.get(affiliationId);
    if (previous) previousPersons.set(previous.personItemId, previous.personBoardId);
    const summary = await mondayClient.getAffiliationSummary(affiliationId, cfg.columns.personLink);
    if (summary === null) {
      console.warn(`donation-rollups consumer: affiliation "${affiliationId}" no longer exists on Monday — skipped`);
      continue;
    }
    if (summary.personItemId !== null && summary.personBoardId !== null) {
      await affiliationsStore.upsert({ affiliationItemId: affiliationId, personItemId: summary.personItemId,
        personBoardId: summary.personBoardId, name: summary.name }, now);
      persons.set(summary.personItemId, summary.personBoardId);
    }
    const totals = await giftsStore.attributedTotals(affiliationId, receivedStatusLabel);
    await mondayClient.changeColumnValues(cfg.boardId, affiliationId,
      attributedToColumnValues(attributedRollupFromTotals(totals), cfg.columns));
  }
  // Review finding 2: a stale D1 row for one affiliation must never clobber a fresh summary
  // written by another affiliation for the same person — so previous rows only fill in persons
  // no affiliation this pass resolved fresh (e.g. the affiliation was deleted on Monday).
  for (const [personItemId, personBoardId] of previousPersons) {
    if (!persons.has(personItemId)) persons.set(personItemId, personBoardId);
  }
  for (const [personItemId, personBoardId] of persons) {
    const column = ownerColumnsByBoard[personBoardId]?.organizationalGiving;
    if (!column) {
      console.warn(`donation-rollups consumer: no organizationalGiving column for board "${personBoardId}" — Organizational Giving for "${personItemId}" not written`);
      continue;
    }
    const totals = await giftsStore.organizationalGivingTotals(personItemId, receivedStatusLabel);
    await mondayClient.changeColumnValues(Number(personBoardId), personItemId, { [column]: organizationalGivingColumnValue(totals.cents) });
  }
}
