import type { PendingStore } from '../db/pending';
import type { DonationLinksStore } from '../db/links';
import type { GiftsStore } from '../db/gifts';
import type { VolunteerActivityStore } from '../db/volunteerActivity';
import type { OwnerRecomputesStore } from '../db/ownerRecomputes';
import type { AffiliationsStore } from '../db/affiliations';
import type { DonationRollupsMondayClient, DonationRecord } from '../monday/client';
import { MondayRateLimitError } from '../monday/client';
import type {
  AffiliationsConfig, DonationRollupsConfig, OwnerColumns, RecomputeQueueMessage,
  DonationBoardConfig, MembershipConfig, OwnerMembershipColumns, DonorLevelConfig,
} from '../types';
import { donorLevel } from '../rollups/donorLevel';
import { computeRollup, currentFiscalYear, localDateParts, type Rollup } from '../rollups/compute';
import {
  buildGiftLedgerJson, buildGiftHistoryMarkdown, countTableRows, DESCRIPTION_TABLE_ROW_BUDGET,
  GIFT_LEDGER_ALERT_BYTES, type GiftLedgerProjection, type GiftHistoryRow,
} from '../projections/giftHistory';
import { isD1QuotaError, secondsUntilMidnightUTC } from './quota';
import { logDebug, messageDisposition, retryDelaySeconds } from '../flags';
import { dryRunConsumerDeps, type BatchSkipContext } from '../writeSwitch';
import {
  deriveMembership, mergeWithBoard, statusFor, tierFromLabel,
  membershipColumnValues, termColumnValues, type MembershipGift,
} from '../membership/derive';
import { attributedRollupFromTotals, attributedToColumnValues, organizationalGivingColumnValue } from '../rollups/attributed';
import { formatCents } from '../money';
import { buildSponsorshipsMarkdown } from '../projections/sponsorships';
import { registrationQualifies } from '../membership/volunteer';
import { employerNameFor } from '../affiliations/employer';

export interface QueueMessageLike<T> {
  body: T;
  // When the message was sent (Cloudflare's Message.timestamp) — the dead-letter consumer
  // compares it against a pending row's written_at to spot stale dead messages.
  timestamp?: Date;
  // Delivery attempt, 1 on first delivery (Cloudflare's Message.attempts) — drives the retry
  // backoff. Optional so test doubles needn't set it.
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface ProcessBatchDeps {
  pendingStore: PendingStore;
  linksStore: DonationLinksStore;
  giftsStore: GiftsStore;
  volunteerStore: VolunteerActivityStore;
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

// Another recompute of the same owner holds its lease (migration 0010). Not a failure: the message
// waits a short, fixed delay and re-reads Monday once the holder has written — often to find a
// fresh enough fetch that it coalesces away.
class OwnerBusyError extends Error {}
const OWNER_BUSY_RETRY_SECONDS = 30;
// Longer than any healthy recompute (seconds, or a minute or two of in-process Monday retries),
// short enough that a holder that died mid-recompute only blocks its owner for a few retries.
const OWNER_LEASE_TTL_MS = 5 * 60_000;

// A first run after enabling the membership feature, or a widened eligibleGiftTypes, can leave
// dozens of unstamped gifts on one owner; each stamp is one Monday mutation and the Free plan's
// subrequest cap is 50 per invocation. The design converges (spec "Writes and idempotency"), so
// stamp the first N per recompute and let the stamped gifts' own webhooks recompute and continue.
const MAX_GIFT_TERM_WRITES_PER_RECOMPUTE = 10;

// The queue entry point (index.ts): the write switch's mode, read once for the batch, decides per
// message whether the recompute writes (`on`, unstamped), dry-runs against recording proxies
// (`off`, or stamped dropped by the webhook), or waits on the queue (`hold`, `unknown`).
export async function consumeRecomputeBatch(
  messages: QueueMessageLike<RecomputeQueueMessage>[], deps: ProcessBatchDeps, gate: BatchSkipContext,
): Promise<void> {
  await runBatch(messages, (message) => {
    const ctx = { ...gate, deliveryId: deliveryIdOf(message.body) };
    const disposition = messageDisposition(gate.mode, message.body);
    logDebug(ctx, 'disposition', { disposition, writeStamp: message.body.writeStamp ?? null, attempts: message.attempts ?? null });
    if (disposition === 'retry') return null;
    return disposition === 'write' ? { deps, dryRun: false } : { deps: dryRunConsumerDeps(deps, ctx), dryRun: true };
  });
}

// The recompute itself, with the deps it is given — live, or a dry run's proxies.
export async function processRecomputeBatch(
  messages: QueueMessageLike<RecomputeQueueMessage>[], deps: ProcessBatchDeps,
): Promise<void> {
  await runBatch(messages, () => ({ deps, dryRun: false }));
}

function deliveryIdOf(body: RecomputeQueueMessage): string {
  const owner = body.ownerItemId !== undefined ? `:owner:${body.ownerItemId}` : '';
  return `${body.kind ?? 'donation'}:${body.donationItemId}${owner}`;
}

// depsFor returns null for a message the write switch holds on the queue.
async function runBatch(
  messages: QueueMessageLike<RecomputeQueueMessage>[],
  depsFor: (message: QueueMessageLike<RecomputeQueueMessage>) => { deps: ProcessBatchDeps; dryRun: boolean } | null,
): Promise<void> {
  // Once D1 has refused a query for the day, or Monday has said the token's budget is spent,
  // every later message in this batch would fail the same way after spending Monday calls of
  // its own — defer them all to the same moment instead. A deferred sibling's retry() still
  // counts against its own max_retries, same as the D1-quota deferral; one that runs out lands
  // in the DLQ, where processDeadLetters marks it failed and it can be re-driven.
  let batchDelaySeconds: number | null = null;
  for (const message of messages) {
    const { donationItemId } = message.body;
    if (batchDelaySeconds !== null) {
      message.retry({ delaySeconds: batchDelaySeconds });
      continue;
    }
    const chosen = depsFor(message);
    if (chosen === null) {
      // `hold` or an unreadable switch: not processed, not dropped — back on the queue at the
      // shared backoff (1 minute doubling to an hour) until the mode is `on` or `off`.
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    const { deps, dryRun } = chosen;
    try {
      // A dry-run delivery is closed out as 'dropped' (the one pending write a dry run makes —
      // writeSwitch.ts dryRunPendingStore), so the nightly requeue can't re-send it as live work
      // later. An owner-keyed message has no pending row of its own: its donationItemId is the
      // gift whose own row tracks the message that fanned it out.
      if (dryRun && message.body.ownerItemId === undefined) {
        await deps.pendingStore.updateStatus(donationItemId, 'dropped');
      }
      await processOne(message.body, deps);
      message.ack();
    } catch (err) {
      if (err instanceof OwnerBusyError) {
        console.log(`donation-rollups consumer: donation "${donationItemId}": ${err.message} — retrying in ${OWNER_BUSY_RETRY_SECONDS}s`);
        message.retry({ delaySeconds: OWNER_BUSY_RETRY_SECONDS });
        continue;
      }
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
      // The classification is unchanged; every delay is the shared retryDelaySeconds (1 minute
      // doubling to an hour, across wrangler.jsonc's max_retries of 100), raised to a hint.
      if (err instanceof NonRetryableError) {
        message.ack();
      } else if (isD1QuotaError(err)) {
        // D1's daily limit resets at midnight UTC — the retry worth making is the one after it.
        batchDelaySeconds = retryDelaySeconds(message.attempts, secondsUntilMidnightUTC(deps.now ?? new Date()));
        console.error(`donation-rollups consumer: D1 daily quota exhausted — deferring this and the rest of the batch ${batchDelaySeconds}s (to midnight UTC)`);
        message.retry({ delaySeconds: batchDelaySeconds });
      } else if (err instanceof MondayRateLimitError) {
        // Issue #27: retrying straight back into an exhausted complexity budget just burns the
        // message's retries into the DLQ. Wait out Monday's hint, backing off per attempt. The
        // daily call limit with no hint resets at midnight UTC — defer to it exactly as the D1
        // quota does. A hinted delay (midnight, or Monday's own) is capped at Queues' 12 h — a
        // capped retry fails fast on its first Monday call and defers again; an unhinted one at
        // the shared backoff's hour.
        const hintSeconds = err.daily && err.retryInSeconds === undefined
          ? secondsUntilMidnightUTC(deps.now ?? new Date())
          : err.retryInSeconds === undefined ? undefined : Math.ceil(err.retryInSeconds);
        batchDelaySeconds = retryDelaySeconds(message.attempts, hintSeconds);
        console.error(`donation-rollups consumer: Monday rate limit (retry hint ${err.retryInSeconds ?? 'none'}s, attempt ${message.attempts ?? '?'}) — deferring this and the rest of the batch ${batchDelaySeconds}s`);
        message.retry({ delaySeconds: batchDelaySeconds });
      } else {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  }
}

async function processOne(message: RecomputeQueueMessage, deps: ProcessBatchDeps): Promise<void> {
  const { donationItemId, donationBoardId } = message;
  const { mondayClient, config } = deps;
  const { donationBoards } = config.donationRollups;

  if (message.kind === 'registration') {
    await processRegistration(message, deps);
    return;
  }

  if (message.kind === 'affiliation') {
    await processAffiliation(message, deps);
    return;
  }

  // An owner-keyed message: a gift moved away from this owner (issue #26). Recompute it
  // unconditionally — its totals still include the gift until it does.
  if (message.ownerItemId !== undefined && message.ownerBoardId !== undefined) {
    if (await ownerIsGone(deps, message.ownerItemId)) return;
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

  // Non-link column change on a donation D1 already links (issue #89): coalesce from the D1 link
  // alone, with no Monday call. A miss falls through to the full path below.
  if (message.columnId !== undefined && message.columnId !== sourceBoard.columns.donorLink && message.sweep !== true) {
    const known = await deps.linksStore.getLinkForDonation(donationItemId);
    if (known?.updatedAt !== undefined && await coalesceIfCovered(deps, donationItemId, known, false, known.updatedAt)) return;
  }

  const donorLink = await mondayClient.getDonorLinkWithBoard(donationItemId, sourceBoard.columns.donorLink);
  let ownerItemId = donorLink?.ownerItemId ?? null;
  let ownerBoardId = donorLink?.ownerBoardId ?? null;
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
    const fallback = await deps.linksStore.getLinkForDonation(donationItemId);
    ownerItemId = fallback?.ownerItemId ?? null;
    ownerBoardId = fallback === null ? null : await mondayClient.getItemBoardId(fallback.ownerItemId);
  }
  if (ownerItemId === null) {
    // Legitimately nothing to recompute — an archived donation unknown to D1 isn't a transient
    // failure, so this is a benign skip, not a retry candidate.
    await deps.pendingStore.updateStatus(donationItemId, 'written', { writtenAt: new Date().toISOString() });
    return;
  }

  if (ownerBoardId === null) {
    // The owner was deleted (getItemBoardId reads a trashed item as gone). Retrying can't bring it
    // back, and a gift whose owner is gone counts for no one — the same as a cleared link.
    await detachDonation(deps, donationItemId, 'owner deleted');
    await deps.pendingStore.updateStatus(donationItemId, 'written', { writtenAt: new Date().toISOString() });
    return;
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
  // (or one rewritten after the fetch) can't have been covered. A custodian sweep message, no
  // pending row, or no prior recompute means recompute: a sweep's representative gift can still
  // have an old open row, and skipping would leave that owner out of the sweep.
  if (message.sweep !== true && await coalesceIfCovered(deps, donationItemId,
    { ownerItemId, ownerBoardId }, link.changed, link.updatedAt)) return;

  // The gift moved here from another owner (issue #26): that owner's totals still include it.
  // Queued rather than recomputed inline — a second full recompute in this invocation would
  // blow the per-invocation subrequest budget max_batch_size is sized for. Queued *before* the
  // inline recompute: the link row already says the new owner, so if that recompute throws and
  // the retry finds the link unchanged, the previous owner would otherwise never be queued.
  if (link.previousOwner !== undefined) {
    await enqueueOwnerRecompute(deps, message, link.previousOwner);
  }

  await recomputeOwner(deps, ownerItemId, ownerBoardId, donationItemId);

  await deps.pendingStore.updateStatus(donationItemId, 'written', {
    ownerItemId, ownerBoard: ownerBoardId, writtenAt: new Date().toISOString(),
  });
}

// The coalescing rule above, shared by the D1-only shortcut (issue #89) and the full path. True
// when the donation was acked as covered by an earlier recompute of its owner.
async function coalesceIfCovered(
  deps: ProcessBatchDeps, donationItemId: string, owner: { ownerItemId: string; ownerBoardId: string },
  linkChanged: boolean, linkUpdatedAt: string,
): Promise<boolean> {
  const [last, pending] = await Promise.all([
    deps.recomputesStore.get(owner.ownerItemId),
    deps.pendingStore.getPending(donationItemId),
  ]);
  if (last === null || pending === null || last.fetchedAt < pending.receivedAt
    || linkChanged || linkUpdatedAt > last.fetchedAt) return false;
  console.log(`donation-rollups consumer: coalesced donation "${donationItemId}" — owner ${owner.ownerItemId} already fetched at ${last.fetchedAt}, after its webhook at ${pending.receivedAt}`);
  await deps.pendingStore.updateStatus(donationItemId, 'written', {
    ownerItemId: owner.ownerItemId, ownerBoard: owner.ownerBoardId, writtenAt: new Date().toISOString(),
  });
  return true;
}

// Issue #26: a deleted donation, or an active one whose Donor link was cleared, must stop counting
// toward the owner D1 last linked it to. Drop the link, take the gift out of the ledger's totals
// (soft — a restore or re-link brings it back on its next recompute), then recompute that owner
// here: this message has no other recompute to do, so it costs no more than a normal one.
async function detachDonation(deps: ProcessBatchDeps, donationItemId: string, state: 'active' | 'deleted' | 'owner deleted'): Promise<void> {
  const link = await deps.linksStore.getLinkForDonation(donationItemId);
  const removed = await deps.giftsStore.markRemoved(donationItemId, new Date().toISOString());
  await deps.linksStore.deleteLink(donationItemId);
  const previous = link ?? (removed === null ? null : { ownerItemId: removed.ownerItemId, ownerBoardId: removed.ownerBoardId });
  if (previous === null) return; // never linked to anyone D1 knows — nothing to recompute
  // Deleting a donor clears (or orphans) every gift's link at once: the former owner is gone, so
  // there is nothing to rewrite.
  if (await ownerIsGone(deps, previous.ownerItemId)) return;
  const why = state === 'deleted' ? 'was deleted' : state === 'owner deleted' ? 'lost its deleted owner' : 'lost its Donor link';
  console.log(`donation-rollups consumer: donation "${donationItemId}" ${why} — recomputing former owner ${previous.ownerItemId}`);
  const extraAffiliations = new Set<string>();
  if (removed?.actingForItemId) extraAffiliations.add(removed.actingForItemId);
  await recomputeOwner(deps, previous.ownerItemId, previous.ownerBoardId, donationItemId, extraAffiliations);
}

// An Event Registrations item changed (spec 2026-10-09 "Architecture"): re-read it, store whether
// it qualifies as a check-in, and recompute the attendee — plus whoever it counted for before,
// when the Attendee link moved or the item was deleted. Same division of labor as a Donor re-point.
async function processRegistration(message: RecomputeQueueMessage, deps: ProcessBatchDeps): Promise<void> {
  const { donationItemId: registrationItemId, donationBoardId: boardId } = message;
  const { mondayClient, volunteerStore, config } = deps;
  const board = config.donationRollups.volunteerBoards.find((b) => String(b.boardId) === boardId);
  if (board === undefined) {
    throw new NonRetryableError(`config: no volunteerBoards entry for board id "${boardId}" (this registration's board)`);
  }
  const now = new Date().toISOString();
  const owners: { ownerItemId: string; ownerBoardId: string }[] = [];

  const reg = await mondayClient.getRegistration(registrationItemId, board);
  if (reg !== null && reg.state === 'archived') {
    // An archived item reads its board relations back empty (the archived-gift trap, issue #26),
    // so a re-read would wrongly unlink the attendee: keep the stored row as it was, recompute nobody.
    console.log(`donation-rollups consumer: registration "${registrationItemId}" is archived — keeping its last read`);
    await deps.pendingStore.updateStatus(registrationItemId, 'written', { writtenAt: new Date().toISOString() });
    return;
  }
  if (reg === null || reg.state === 'deleted') {
    const removed = await volunteerStore.markRemoved(registrationItemId, now);
    if (removed !== null) owners.push(removed);
  } else {
    const eventStart = reg.eventItemId === null ? null : await mondayClient.getEventStart(reg.eventItemId, board.eventBoard.columns.start);
    const ownerBoardId = reg.attendeeItemId === null ? null : await mondayClient.getItemBoardId(reg.attendeeItemId);
    const qualifies = registrationQualifies(reg, eventStart, board);
    const { previousOwner } = await volunteerStore.upsert({
      registrationItemId, boardId, ownerItemId: reg.attendeeItemId, ownerBoardId,
      activityDateISO: eventStart, hours: reg.hours, qualifies, source: 'webhook',
    }, now);
    if (reg.attendeeItemId !== null && ownerBoardId !== null) owners.push({ ownerItemId: reg.attendeeItemId, ownerBoardId });
    if (previousOwner !== null && previousOwner.ownerItemId !== reg.attendeeItemId) owners.push(previousOwner);
  }

  // Only People boards carry membership columns; a registration linked elsewhere is recorded
  // (the link may move later) but recomputes nothing. First owner inline, the rest queued —
  // a second full recompute here would blow the per-invocation budget max_batch_size is tuned for.
  // The rest are queued *before* the inline recompute: the upsert above already moved the stored
  // owner, so a retry after a failed recompute would no longer see the previous one.
  const recomputable = owners.filter((o) => config.donationRollups.ownerColumnsByBoard[o.ownerBoardId]?.membership !== undefined);
  const [first, ...rest] = recomputable;
  for (const o of rest) await enqueueOwnerRecompute(deps, message, o);
  // Only the attendee was just read live; an owner from a stored row may since have been deleted.
  if (first !== undefined && (first.ownerItemId === reg?.attendeeItemId || !(await ownerIsGone(deps, first.ownerItemId)))) {
    await recomputeOwner(deps, first.ownerItemId, first.ownerBoardId, registrationItemId);
  }

  await deps.pendingStore.updateStatus(registrationItemId, 'written', {
    ...(first ? { ownerItemId: first.ownerItemId, ownerBoard: first.ownerBoardId } : {}), writtenAt: new Date().toISOString(),
  });
}

// An Affiliations item changed: re-read the person's affiliations and bring Employer Name in line.
// Reads Monday fresh every time, so a retry or a duplicate delivery lands on the same answer and
// the write is skipped once the column already matches. A re-pointed Person keeps the old person's
// Employer Name as it was, the same as a Former affiliation (affiliations/employer.ts).
async function processAffiliation(message: RecomputeQueueMessage, deps: ProcessBatchDeps): Promise<void> {
  const { donationItemId: affiliationItemId } = message;
  const { mondayClient, pendingStore, config } = deps;
  const affiliations = config.affiliations;
  const sync = affiliations?.employerSync;
  let owner: { ownerItemId: string; ownerBoard: string } | undefined;
  if (affiliations && sync) {
    const summary = await mondayClient.getAffiliationSummary(affiliationItemId, affiliations.columns.personLink);
    const columns = summary?.personBoardId ? sync.ownerColumnsByBoard[summary.personBoardId] : undefined;
    if (summary?.personItemId && summary.personBoardId) {
      if (columns === undefined) {
        console.warn(`donation-rollups consumer: no employerSync entry for board "${summary.personBoardId}" — Employer Name for "${summary.personItemId}" not written`);
      } else {
        owner = { ownerItemId: summary.personItemId, ownerBoard: summary.personBoardId };
        const state = await mondayClient.getPersonEmployerState(summary.personItemId, columns);
        if (state !== null) {
          const ids = [...new Set([...state.affiliationItemIds, affiliationItemId])];
          const employerName = employerNameFor(await mondayClient.getEmployerAffiliations(ids, sync.columns), affiliationItemId, sync.currentStatusLabel);
          if (employerName !== null && employerName !== state.employerName) {
            await mondayClient.changeColumnValues(Number(summary.personBoardId), summary.personItemId, { [columns.employerName]: employerName });
          }
        }
      }
    }
  }
  await pendingStore.updateStatus(affiliationItemId, 'written', { ...owner, writtenAt: new Date().toISOString() });
}

// An owner D1 remembers (a former owner, an owner-keyed message) may have been deleted on Monday
// since. Its recompute could only fail on the write and retry toward the DLQ; skip it instead.
async function ownerIsGone(deps: ProcessBatchDeps, ownerItemId: string): Promise<boolean> {
  if ((await deps.mondayClient.getItemBoardId(ownerItemId)) !== null) return false;
  console.log(`donation-rollups consumer: owner ${ownerItemId} was deleted on Monday — nothing to recompute`);
  return true;
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
//
// Held under the owner's lease from before the read to after the write: two recomputes of one
// owner running at once (max_concurrency > 1) could otherwise read, then write, out of order, and
// the stale one would overwrite the fresh totals with nothing left to repair them.
async function recomputeOwner(
  deps: ProcessBatchDeps, ownerItemId: string, ownerBoardId: string, donationItemId: string,
  extraAffiliations: Set<string> = new Set(),
): Promise<void> {
  const holder = crypto.randomUUID();
  const now = Date.now();
  const leased = await deps.recomputesStore.acquireLease(ownerItemId, holder,
    new Date(now).toISOString(), new Date(now + OWNER_LEASE_TTL_MS).toISOString());
  if (!leased) throw new OwnerBusyError(`owner ${ownerItemId} is being recomputed by another message`);
  try {
    await recomputeOwnerLeased(deps, ownerItemId, ownerBoardId, donationItemId, extraAffiliations);
  } finally {
    // A failed release leaves the lease to expire; it must not turn a good recompute into a retry.
    try {
      await deps.recomputesStore.releaseLease(ownerItemId, holder);
    } catch (err) {
      console.warn(`donation-rollups consumer: could not release the lease on owner ${ownerItemId} (it expires on its own): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// The per-board read columns; the three sponsorship columns ride along only when the feature is on.
function readColumns(columns: DonationBoardConfig['columns'], sponsorships: boolean): DonationBoardConfig['columns'] {
  if (sponsorships) return columns;
  const { sponsorshipCycle: _c, inKindValue: _v, sponsorshipPipelineLinks: _p, ...rest } = columns;
  return rest as DonationBoardConfig['columns'];
}

async function recomputeOwnerLeased(
  deps: ProcessBatchDeps, ownerItemId: string, ownerBoardId: string, donationItemId: string,
  extraAffiliations: Set<string>,
): Promise<void> {
  const { mondayClient, config } = deps;
  const { donationBoards, receivedStatusLabel, ownerColumnsByBoard } = config.donationRollups;
  const ownerColumns = ownerColumnsByBoard[ownerBoardId];
  if (ownerColumns === undefined) {
    throw new Error(`config: no ownerColumnsByBoard entry for board id "${ownerBoardId}" (this owner's board)`);
  }

  const fetchedAt = new Date().toISOString();
  const sponsorshipsCfg = config.donationRollups.sponsorships;

  // Monday has no supported filter for board_relation columns (confirmed 2026-08-24 —
  // items_page_by_column_values rejects it outright), so "every Donation this owner
  // has" comes from the D1 reverse index, not a live Monday query. getDonationsByIds
  // then fetches those specific items directly, grouped by board since column ids
  // differ per Donations era board.
  const linksByBoard = await deps.linksStore.getLinksForOwner(ownerItemId);
  const perBoard = await Promise.all(donationBoards
    .filter((b) => linksByBoard.has(String(b.boardId)))
    .map(async (b) => ({ board: b, items: await mondayClient.getDonationsByIds(linksByBoard.get(String(b.boardId))!, readColumns(b.columns, sponsorshipsCfg !== null), config.fiscalYear.startMonth) })));
  const donations = perBoard.flatMap((p) => p.items);

  // Sponsorship facts (only when the feature is configured): the event a gift belongs to is its
  // Sponsorship Cycle label, else the board + group of the pipeline item it links to. One lookup
  // for every pipeline id this recompute read.
  const eventByGift = new Map<string, string>();
  if (sponsorshipsCfg !== null) {
    const pipelineIds = [...new Set(donations.flatMap((d) => (d.archived || d.sponsorshipCycle ? [] : d.pipelineItemId ? [d.pipelineItemId] : [])))];
    const placed = pipelineIds.length > 0 ? await mondayClient.getItemsBoardAndGroup(pipelineIds) : new Map<string, { boardId: string; groupTitle: string }>();
    for (const d of donations) {
      if (d.archived) continue;
      let event = d.sponsorshipCycle ?? '';
      if (event === '' && d.pipelineItemId) {
        const at = placed.get(d.pipelineItemId);
        const boardName = at ? sponsorshipsCfg.pipelineBoards[at.boardId] : undefined;
        if (at && boardName !== undefined) event = `${boardName} ${at.groupTitle}`.trim();
      }
      eventByGift.set(d.id, event);
    }
  }

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
      termStart: d.termStart,               // undefined: no Term Start column; null: blank (leave stored)
      ...(sponsorshipsCfg !== null ? {
        // archived: link columns read back empty (issue #26), so leave the stored event alone
        sponsorshipEvent: d.archived ? undefined : (eventByGift.get(d.id) ?? ''),
        // undefined (leave stored) when the board has no In-kind Value column
        ...(d.inKindValueCents !== undefined ? { inKindValueCents: d.inKindValueCents ?? 0 } : {}),
      } : {}),
    })),
    'webhook', new Date().toISOString());
  if (refreshed.changed > 0) {
    console.log(`donation-rollups consumer: owner ${ownerItemId}: ${refreshed.changed} of ${donations.length} gift facts changed`);
  }

  const thisFY = currentFiscalYear(deps.now ?? new Date(), config.fiscalYear);
  const rollup = computeRollup(donations, receivedStatusLabel, thisFY);

  // The ledger history, read ahead of the membership step because both it and the gift-history
  // projections below want it: it carries gift types and archived state for the full history,
  // including gifts archived long before this webhook.
  const history = await deps.giftsStore.giftsForOwner(ownerItemId);

  // Membership write path (spec 2026-10-09): only for owners on a board with the eight
  // membership columns, and only when the feature block is configured. Organizations and a
  // null block both skip silently — neither is a fault.
  const membership = config.donationRollups.membership;
  const membershipColumns = ownerColumns.membership;
  let membershipValues: Record<string, unknown> = {};
  const giftTermWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] = [];
  if (membership !== null && membershipColumns !== undefined) {
    const step = await planMembershipWrites(deps, ownerItemId, membershipColumns, membership, perBoard, history);
    membershipValues = step.ownerValues;
    giftTermWrites.push(...step.giftWrites);
  }

  // Gift-history projections (docs/20 §5.5) ride the same write: the JSON column goes into
  // the one change_multiple_column_values call, the markdown description is its own call.
  // Sourced from the ledger (see `history` above).
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
    ...rollupToColumnValues(rollup, ownerColumns, config.donationRollups.donorLevel),
    [ownerColumns.giftLedgerJson]: ledgerProjection.json,
    ...membershipValues,
  };

  // Issue #88: skip the two mutations when what we'd write hashes the same as the last write.
  // The columns are read-only for staff (🔒), so a hand edit drifting past this is the accepted
  // cost; the hash is cleared whenever a write doesn't land.
  const lastRecompute = await deps.recomputesStore.get(ownerItemId);
  const valuesHash = await sha256Hex(JSON.stringify(columnValues));
  if (lastRecompute?.valuesHash !== valuesHash) {
    await mondayClient.changeColumnValues(Number(ownerBoardId), ownerItemId, columnValues);
  }
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
  let descriptionHash: string | null = null;
  try {
    const sponsorshipsMd = sponsorshipsCfg !== null && ownerBoardId === String(sponsorshipsCfg.organizationsBoardId)
      ? buildSponsorshipsMarkdown(history, sponsorshipsCfg, receivedStatusLabel, config.fiscalYear, config.monday.accountUrl,
        localISODate(deps.now ?? new Date(), config.fiscalYear.timeZone))
      : null;
    // Sponsorships is what gets copied to an auditor, so it keeps every row and Gift History takes
    // what's left of the budget. The largest sandbox sponsor renders 22 rows, so no cut of its own.
    const giftHistoryMd = buildGiftHistoryMarkdown(history, deps.config.monday.accountUrl, driven,
      DESCRIPTION_TABLE_ROW_BUDGET - countTableRows(sponsorshipsMd ?? ''));
    const description = sponsorshipsMd !== null ? `${sponsorshipsMd}\n\n${giftHistoryMd}` : giftHistoryMd;
    const hash = await sha256Hex(description);
    if (lastRecompute?.descriptionHash !== hash) await mondayClient.setItemDescription(ownerItemId, description);
    descriptionHash = hash;
  } catch (err) {
    // Non-fatal by design: the markdown description is a redundant human rendering of the
    // Gift Ledger JSON column, and set_item_description_content 500s outright on any board
    // whose item view lacks the Item description widget (UI-only setup) or on a description past
    // Monday's block limit (DESCRIPTION_TABLE_ROW_BUDGET). The rollups and JSON projection above already
    // landed; don't burn queue retries over the optional rendering.
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
  await deps.recomputesStore.record({ ownerItemId, ownerBoardId, fetchedAt, writtenAt: new Date().toISOString(), valuesHash, descriptionHash });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// YYYY-MM-DD for `now` in `timeZone` (the Sponsorships window rolls over on the local New Year).
function localISODate(now: Date, timeZone: string): string {
  const { year, month, day } = localDateParts(now, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function planMembershipWrites(
  deps: ProcessBatchDeps, ownerItemId: string,
  columns: OwnerMembershipColumns, membership: MembershipConfig,
  perBoard: { board: DonationBoardConfig; items: DonationRecord[] }[],
  history: GiftHistoryRow[],
): Promise<{ ownerValues: Record<string, unknown>; giftWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] }> {
  const { mondayClient, volunteerStore, config } = deps;
  const todayISO = (deps.now ?? new Date()).toISOString().slice(0, 10);

  // Activity comes from the ledger, not the Monday fetch: the ledger carries every gift the owner
  // ever had, archived ones included, plus the migrated Term Start (spec 2026-10-09 "Qualifying
  // activities"). The fetch only decides which active gifts can still take a stamp.
  const gifts: MembershipGift[] = history.map((g) => ({
    id: g.mondayItemId, dateISO: g.giftDateISO, amountCents: g.amountCents, status: g.status,
    giftType: g.giftType, termStart: g.termStart ?? null,
  }));
  const volunteers = await volunteerStore.forOwner(ownerItemId);
  const derived = deriveMembership(gifts, volunteers, membership, config.donationRollups.receivedStatusLabel, todayISO);
  // No qualifying activity anywhere: never rewrite a hand-set membership or flip Status —
  // Status on the calendar is the native automation's job, not ours.
  if (derived.state === null) return { ownerValues: {}, giftWrites: [] };

  const board = await mondayClient.getOwnerMembership(ownerItemId, columns);
  const merged = mergeWithBoard(derived.state, { since: board.since, until: board.until, tier: tierFromLabel(board.tierLabel, membership) });
  const ownerValues = membershipColumnValues(merged, statusFor(merged, todayISO), board, columns, membership);
  // Lifetime came from the board (migrated or staff-granted), not the ledger: the derivation
  // doesn't know, and would stamp New/Continuing terms on gifts to someone who is already a life
  // member. Keep only Lifetime stamps (Salesforce's "already a life member" exit).
  const terms = merged.tier === 'lifetime' && derived.state.tier !== 'lifetime'
    ? new Map([...derived.terms].filter(([, t]) => t.type === 'lifetime'))
    : derived.terms;

  const candidates = perBoard.flatMap(({ board: b, items }) => {
    const cols = b.columns;
    if (!cols.termStart || !cols.termEnd || !cols.membershipType) return [];
    return items.map((d) => ({ board: b, d, cols: { termStart: cols.termStart!, termEnd: cols.termEnd!, membershipType: cols.membershipType! } }));
  }).sort((a, b) => (a.d.dateISO < b.d.dateISO ? -1 : a.d.dateISO > b.d.dateISO ? 1 : a.d.id < b.d.id ? -1 : a.d.id > b.d.id ? 1 : 0));

  const giftWrites: { boardId: number; itemId: string; values: Record<string, unknown> }[] = [];
  for (const { board: b, d, cols } of candidates) {
    const values = termColumnValues(terms.get(d.id),
      { termStart: d.termStart ?? null, termEnd: d.termEnd ?? null, membershipType: d.membershipType ?? null }, cols, membership);
    if (Object.keys(values).length > 0) giftWrites.push({ boardId: b.boardId, itemId: d.id, values });
  }
  if (giftWrites.length > MAX_GIFT_TERM_WRITES_PER_RECOMPUTE) {
    console.log(`donation-rollups: owner ${ownerItemId} has ${giftWrites.length - MAX_GIFT_TERM_WRITES_PER_RECOMPUTE} more gift term stamps pending; continuing on the next recompute`);
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

export function rollupToColumnValues(r: Rollup, columns: OwnerColumns, level: DonorLevelConfig | null = null): Record<string, unknown> {
  const values: Record<string, unknown> = {
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
  if (columns.donorLevel && level) {
    const label = donorLevel(r, level);
    values[columns.donorLevel] = label === null ? '' : { label };
  }
  return values;
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
