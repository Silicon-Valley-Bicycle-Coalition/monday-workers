import type { GiftsStore } from '../db/gifts';
import type { PendingStore } from '../db/pending';
import type { DonationRollupsConfig, RecomputeQueueMessage } from '../types';
import { currentFiscalYear } from '../rollups/compute';
import { parseGiftLedgerJson } from '../projections/giftHistory';

// The custodian (docs/20 §5.3 in the private planning repo): the four recurring duties that
// keep the archive-in-place Donations board and its projections healthy. Each duty is pure
// enough to run from cron OR an authenticated HTTP route, returns a JSON report, records
// itself in custodian_runs (the runbook surface), and alerts when it found something a human
// should look at. Nothing here auto-heals silently — mismatches are reported, not patched.

export interface BoardCapacity { id: string; name: string; itemsCount: number; itemsLimit: number | null }

export interface CustodianMondayClient {
  archiveItem(itemId: string): Promise<void>;
  listWorkspaceBoards(workspaceId: number): Promise<BoardCapacity[]>;
  // Raw column text per item, batched by id — several columns share one query, so
  // reconciliation reads Lifetime Giving and the Gift Ledger JSON in the same
  // subrequests. Blank cells come back as null.
  getItemsColumnsText(itemIds: string[], columnIds: string[]): Promise<Map<string, Map<string, string | null>>>;
  createUpdate(itemId: number, body: string): Promise<void>;
  createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<string>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
}

export interface CustodianDeps {
  gifts: GiftsStore;
  pending: PendingStore;
  mondayClient: CustodianMondayClient;
  queue: { sendBatch(messages: RecomputeQueueMessage[]): Promise<void> };
  config: DonationRollupsConfig;
  now?: Date;
}

export interface DutyReport { ok: boolean; summary: string; detail?: unknown }

export const DUTIES = ['archive', 'capacity', 'sweep', 'reconcile', 'requeue'] as const;
export type Duty = (typeof DUTIES)[number];

// Cron schedule, decided by date so one daily trigger covers everything:
// reconcile nightly; capacity every Monday; the July fiscal-year sweep on July 1 (docs/20:
// first week — closes the This/Last Year staleness gap); the year-end archive run on July 15,
// after the sweep's recomputes have settled the new fiscal-year splits.
//
// Sweep and archive slice themselves under the Worker subrequest budget (see runSweep /
// runArchive) and report remaining>0 when incomplete — so a duty whose *most recent* run
// still reports remaining>0 is re-run on every subsequent daily trigger until it completes.
// Without this, a start-date run that couldn't finish in one slice would never get its
// continuation from cron (and the year-end summaries, gated on remaining === 0, would never
// materialize). Cursor resume inside each duty picks up where the last slice stopped.
export function dutiesForDate(now: Date, lastRuns: { duty: string; report: unknown }[] = []): Duty[] {
  const duties: Duty[] = ['reconcile', 'requeue']; // requeue: fix 5, nightly with reconcile
  if (now.getUTCDay() === 1) duties.push('capacity');
  if (now.getUTCMonth() === 6 && now.getUTCDate() === 1) duties.push('sweep');
  if (now.getUTCMonth() === 6 && now.getUTCDate() === 15) duties.push('archive');
  for (const duty of ['sweep', 'archive'] as const) {
    if (duties.includes(duty)) continue;
    const last = lastRuns.find((r) => r.duty === duty)?.report as
      { detail?: { remaining?: number } } | undefined;
    if ((last?.detail?.remaining ?? 0) > 0) duties.push(duty);
  }
  return duties;
}

export async function runDuty(duty: Duty, deps: CustodianDeps): Promise<DutyReport> {
  const now = deps.now ?? new Date();
  let report: DutyReport;
  try {
    report =
      duty === 'archive' ? await runArchive(deps, now)
      : duty === 'capacity' ? await runCapacity(deps)
      : duty === 'sweep' ? await runSweep(deps)
      : duty === 'requeue' ? await runRequeue(deps, now)
      : await runReconcile(deps);
  } catch (err) {
    report = { ok: false, summary: `${duty} crashed: ${err instanceof Error ? err.message : String(err)}` };
  }
  await deps.gifts.recordRun({ duty, ranAt: now.toISOString(), ok: report.ok, report });
  if (!report.ok) await alert(deps, `custodian ${duty}: ${report.summary}`);
  return report;
}

// Year-end archive run: everything active before the retention cutoff gets archived in
// place, then the closed years' annual summaries are (re)materialized from the ledger.
// Idempotent — a re-run archives nothing new and changes no summary. Sliced per run for the
// same subrequest-budget reason as the sweep (a year of gifts ≈ 700 archive calls); an
// incomplete run reports remaining>0 and the next run continues from getArchivable's
// naturally shrinking work list.
const ARCHIVE_PER_RUN = 40;
async function runArchive(deps: CustodianDeps, now: Date): Promise<DutyReport> {
  const { activeFiscalYears } = deps.config.custodian;
  const { receivedStatusLabel } = deps.config.donationRollups;
  const cutoffFY = currentFiscalYear(now) - activeFiscalYears + 1;
  const work = await deps.gifts.getArchivable(cutoffFY);
  const slice = work.slice(0, ARCHIVE_PER_RUN);
  const remaining = work.length - slice.length;

  const archived: string[] = [];
  const failures: { mondayItemId: string; error: string }[] = [];
  for (const g of slice) {
    try {
      await deps.mondayClient.archiveItem(g.mondayItemId);
      archived.push(g.mondayItemId);
    } catch (err) {
      failures.push({ mondayItemId: g.mondayItemId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (archived.length > 0) await deps.gifts.markArchived(archived, now.toISOString());

  // Summaries only once the year's archiving is complete — materializing mid-slice would
  // stamp restatements for totals that aren't final yet.
  let changed: number[] = [];
  let boardItemsWritten = 0;
  if (remaining === 0 && failures.length === 0) {
    const totals = await deps.gifts.fiscalYearTotals(receivedStatusLabel, cutoffFY);
    changed = (await deps.gifts.upsertAnnualSummaries(totals, now.toISOString())).changed;
    boardItemsWritten = await syncAnnualSummaryBoard(deps, new Set(changed));
  }

  return {
    ok: failures.length === 0,
    summary: `archived ${archived.length} gifts before FY${cutoffFY}` +
      (remaining > 0 ? `; ${remaining} remain — run archive again to continue` : '') +
      (failures.length > 0 ? `; ${failures.length} FAILED` : '') +
      (changed.length > 0 ? `; summaries changed for FY ${changed.join(', ')}` : '') +
      (boardItemsWritten > 0 ? `; ${boardItemsWritten} summary board item(s) written` : ''),
    detail: { cutoffFY, archived: archived.length, remaining, failures: failures.slice(0, 20),
      summariesChanged: changed, boardItemsWritten },
  };
}

// The Annual Giving Summary board (docs/20 §5.4): one item per closed fiscal year, written
// only here — matching the requirement that the org/annual view changes only under the
// year-end run or an audit restatement. D1's annual_summaries remains authoritative; the
// board is its staff-facing projection. No-op until custodian.annualSummaryBoardId is set.
async function syncAnnualSummaryBoard(deps: CustodianDeps, changedFYs: Set<number>): Promise<number> {
  const { annualSummaryBoardId, annualSummaryColumns } = deps.config.custodian;
  if (annualSummaryBoardId === null || annualSummaryColumns === null) return 0;
  const summaries = await deps.gifts.getAnnualSummaries();
  let written = 0;
  for (const s of summaries) {
    const needsCreate = s.mondayItemId === null;
    if (!needsCreate && !changedFYs.has(s.fiscalYear)) continue;
    const byType = Object.entries(JSON.parse(s.byTypeJson) as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
      .map(([t, cents]) => `${t}: $${(cents / 100).toFixed(2)}`)
      .join('\n');
    const columnValues: Record<string, unknown> = {
      [annualSummaryColumns.fiscalYear]: String(s.fiscalYear),
      [annualSummaryColumns.total]: String(s.totalCents / 100),
      [annualSummaryColumns.giftCount]: String(s.giftCount),
      [annualSummaryColumns.byType]: byType,
      [annualSummaryColumns.restatedAt]: s.restatedAt ? { date: s.restatedAt.slice(0, 10) } : null,
    };
    if (needsCreate) {
      const itemId = await deps.mondayClient.createItem(annualSummaryBoardId, `FY${s.fiscalYear}`, columnValues);
      await deps.gifts.setSummaryItemId(s.fiscalYear, itemId);
    } else {
      await deps.mondayClient.changeColumnValues(annualSummaryBoardId, s.mondayItemId!, columnValues);
    }
    written++;
  }
  return written;
}

// Capacity alarm: replaces all manual board-size monitoring, not just the Donations board —
// Monday's 10k ceiling counts active items only, and the whole point of archive-in-place is
// that nobody should ever have to watch a count again. This is the backstop.
async function runCapacity(deps: CustodianDeps): Promise<DutyReport> {
  const { workspaceId, capacityAlertPct } = deps.config.custodian;
  const boards = await deps.mondayClient.listWorkspaceBoards(workspaceId);
  const over = boards
    .filter((b) => b.itemsLimit !== null && b.itemsLimit > 0)
    .map((b) => ({ ...b, pct: Math.round((b.itemsCount / b.itemsLimit!) * 100) }))
    .filter((b) => b.pct >= capacityAlertPct);
  return {
    ok: over.length === 0,
    summary: over.length === 0
      ? `all ${boards.length} boards under ${capacityAlertPct}%`
      : over.map((b) => `${b.name} at ${b.pct}% (${b.itemsCount}/${b.itemsLimit})`).join('; '),
    detail: { checked: boards.length, over },
  };
}

// July sweep: recompute every owner once so This/Last Year splits roll over at the fiscal
// boundary even for donors with no new gifts. The recompute queue is donation-keyed, so one
// representative gift per owner triggers that owner's full recompute. Queue sends count
// against the Worker's per-invocation subrequest budget (50 on the Free plan) and sendBatch
// caps at 100 messages, so one invocation covers 3,500 owners and hands the next slice a
// cursor — an incomplete sweep reports remaining>0 and the route is simply called again
// (each duty run picks up where the last incomplete one stopped).
const SWEEP_BATCHES_PER_RUN = 35;
async function runSweep(deps: CustodianDeps): Promise<DutyReport> {
  const lastRuns = await deps.gifts.lastRuns();
  const last = lastRuns.find((r) => r.duty === 'sweep')?.report as
    { detail?: { cursor?: string; remaining?: number } } | undefined;
  const cursor = (last?.detail?.remaining ?? 0) > 0 ? (last?.detail?.cursor ?? '') : '';

  const owners = await deps.gifts.ownersWithOneGift(cursor, SWEEP_BATCHES_PER_RUN * 100 + 1);
  const slice = owners.slice(0, SWEEP_BATCHES_PER_RUN * 100);
  for (let i = 0; i < slice.length; i += 100) {
    await deps.queue.sendBatch(slice.slice(i, i + 100)
      .map((o) => ({ donationItemId: o.mondayItemId, donationBoardId: o.donationBoardId })));
  }
  const remaining = owners.length - slice.length; // >0 means at least one more slice exists
  return {
    ok: true,
    summary: `enqueued recompute for ${slice.length} owners` +
      (remaining > 0 ? ` — more remain, run sweep again to continue` : ''),
    detail: { enqueued: slice.length, remaining, cursor: slice.at(-1)?.ownerItemId ?? cursor },
  };
}

// Nightly requeue (README "operational findings, 2026-09-17", fix 5): pending rows the queue never
// finished — 'received' with no enqueue, or 'queued' whose message expired unconsumed or whose
// batch died before touching D1 (the 09-03/09-09 failure mode) — are re-enqueued, oldest first,
// with their received_at left alone: the consumer's coalescing (fix 3) then makes every message
// after the first per owner a two-read skip, so a flood's worth of stuck rows costs ~one
// recompute per owner. 24h keeps clear of fix 4's up-to-12h quota deferrals (a message that
// old with no outcome is genuinely lost). 'failed' rows are NOT touched — a dead-lettered row
// is a human's signal (see consumer/processDeadLetters.ts). Same slicing as the sweep: queue
// sends count against the subrequest budget, sendBatch caps at 100.
const REQUEUE_BATCHES_PER_RUN = 35;
const REQUEUE_STUCK_AFTER_MS = 24 * 60 * 60 * 1000;
async function runRequeue(deps: CustodianDeps, now: Date): Promise<DutyReport> {
  const cutoff = new Date(now.getTime() - REQUEUE_STUCK_AFTER_MS).toISOString();
  const stuck = await deps.pending.listStuck(cutoff, REQUEUE_BATCHES_PER_RUN * 100 + 1);
  const slice = stuck.slice(0, REQUEUE_BATCHES_PER_RUN * 100);
  for (let i = 0; i < slice.length; i += 100) {
    await deps.queue.sendBatch(slice.slice(i, i + 100)
      .map((r) => ({ donationItemId: r.donationItemId, donationBoardId: r.donationBoardId })));
  }
  const remaining = stuck.length - slice.length;
  if (slice.length === 0) return { ok: true, summary: 'no stuck recomputes', detail: { enqueued: 0, remaining: 0 } };
  // Stuck rows mean the consumer lost work earlier — report it, don't just quietly fix it.
  return {
    ok: false,
    summary: `re-enqueued ${slice.length} stuck recomputes received before ${cutoff}` +
      (remaining > 0 ? ' — more remain, continuing next run' : ''),
    detail: { enqueued: slice.length, remaining, oldest: slice[0]!.receivedAt },
  };
}

// Nightly reconciliation — all four legs docs/20 promises:
//   1. ledger vs Monday's Lifetime Giving column (per owner, sliced),
//   2. ledger vs the Gift Ledger JSON projection column (per owner, same subrequests),
//   3. ledger vs D1's materialized annual_summaries (final slice),
//   4. annual_summaries vs the Annual Giving Summary board items (final slice).
// Mismatches alert; a human decides which side is right (usually the ledger — unless a
// deliberate staff edit simply hasn't landed yet). Sliced like the sweep: Monday caps
// items(ids:) at 100 and the Free plan caps subrequests at 50 per invocation, so each run
// covers RECONCILE_OWNERS_PER_RUN owners and the nightly cron walks the full owner set
// across consecutive nights (2 nights at current volume). Both owner columns ride the
// same batched query (getItemsColumnsText), so leg 2 adds no subrequests; leg 4 adds at
// most one per 100 closed years, only on the final slice.
const RECONCILE_OWNERS_PER_RUN = 4_000;
async function runReconcile(deps: CustodianDeps): Promise<DutyReport> {
  const { receivedStatusLabel, ownerColumnsByBoard } = deps.config.donationRollups;
  const ledger = await deps.gifts.ownerTotals(receivedStatusLabel);

  const lastRuns = await deps.gifts.lastRuns();
  const last = lastRuns.find((r) => r.duty === 'reconcile')?.report as
    { detail?: { cursor?: string; remaining?: number } } | undefined;
  const cursor = (last?.detail?.remaining ?? 0) > 0 ? (last?.detail?.cursor ?? '') : '';

  const allOwners = [...ledger.keys()].sort();
  const startIdx = cursor === '' ? 0 : allOwners.findIndex((o) => o > cursor);
  const slice = startIdx < 0 ? [] : allOwners.slice(startIdx, startIdx + RECONCILE_OWNERS_PER_RUN);
  const remaining = startIdx < 0 ? 0 : allOwners.length - startIdx - slice.length;

  const byBoard = new Map<string, string[]>();
  for (const ownerId of slice) {
    const boardId = ledger.get(ownerId)!.ownerBoardId;
    const list = byBoard.get(boardId) ?? [];
    list.push(ownerId);
    byBoard.set(boardId, list);
  }

  const mismatches: { ownerItemId: string; ledgerCents: number; mondayCents: number | null }[] = [];
  const projectionMismatches: { ownerItemId: string; ledgerCents: number; projectionCents: number | null }[] = [];
  let truncatedProjections = 0;
  let compared = 0;
  for (const [boardId, ownerIds] of byBoard) {
    const columns = ownerColumnsByBoard[boardId];
    if (!columns) continue; // an owner board outside config would already fail recompute loudly
    const monday = await deps.mondayClient.getItemsColumnsText(
      ownerIds, [columns.lifetimeGiving, columns.giftLedgerJson]);
    for (const ownerId of ownerIds) {
      compared++;
      const cols = monday.get(ownerId);
      const ledgerCents = ledger.get(ownerId)!.cents;

      // Leg 1: the Lifetime Giving column. Monday stores floats (714.9300000000001) —
      // compare in rounded cents.
      const lifetimeText = cols?.get(columns.lifetimeGiving) ?? null;
      const mondayCents = lifetimeText === null ? null : Math.round(Number(lifetimeText) * 100);
      if (mondayCents !== ledgerCents) mismatches.push({ ownerItemId: ownerId, ledgerCents, mondayCents });

      // Leg 2: the Gift Ledger JSON projection. Sum its Received entries the way
      // ownerTotals does; an empty or unparseable column is drift too (projectionCents
      // null), since every recompute rewrites it.
      const ledgerText = cols?.get(columns.giftLedgerJson) ?? null;
      const parsed = ledgerText === null ? null : parseGiftLedgerJson(ledgerText);
      if (parsed === null) {
        projectionMismatches.push({ ownerItemId: ownerId, ledgerCents, projectionCents: null });
        continue;
      }
      const received = parsed.entries.filter((e) => e.status === receivedStatusLabel);
      const projectionCents = received.reduce((sum, e) => sum + e.amountCents, 0);
      if (!parsed.truncated) {
        if (projectionCents !== ledgerCents) {
          projectionMismatches.push({ ownerItemId: ownerId, ledgerCents, projectionCents });
        }
      } else {
        // A truncated projection (Finding-1 marker) deliberately omits older gifts, so
        // comparing its sum to the full ledger total would always false-positive.
        // Instead compare the entries it DOES contain against D1's rows for those same
        // gifts — one D1 read per truncated owner, and truncation is rare by design.
        truncatedProjections++;
        const d1ByItem = new Map((await deps.gifts.giftsForOwner(ownerId))
          .filter((g) => g.status === receivedStatusLabel)
          .map((g) => [g.mondayItemId, g.amountCents]));
        const d1Cents = received.reduce((sum, e) => sum + (d1ByItem.get(e.mondayItemId) ?? 0), 0);
        if (projectionCents !== d1Cents) {
          projectionMismatches.push({ ownerItemId: ownerId, ledgerCents: d1Cents, projectionCents });
        }
      }
    }
  }

  // Final-slice checks, once per full pass.
  const staleFYs: number[] = [];
  const summaryBoardMismatches: { fiscalYear: number; ledgerCents: number; boardCents: number | null }[] = [];
  const affiliationMismatches: { affiliationItemId: string; ledgerCents: number; mondayCents: number | null }[] = [];
  const organizationalMismatches: { personItemId: string; ledgerCents: number; mondayCents: number | null }[] = [];
  let summariesChecked = 0;
  let summaryItemsChecked = 0;
  if (remaining === 0) {
    const summaries = await deps.gifts.getAnnualSummaries();
    summariesChecked = summaries.length;

    // Leg 3: annual summaries drift only under audit edits that bypassed the archive run.
    if (summaries.length > 0) {
      const maxFY = Math.max(...summaries.map((s) => s.fiscalYear));
      const fresh = new Map(
        (await deps.gifts.fiscalYearTotals(receivedStatusLabel, maxFY + 1)).map((t) => [t.fiscalYear, t]));
      for (const s of summaries) {
        const f = fresh.get(s.fiscalYear);
        if (!f || f.totalCents !== s.totalCents || f.giftCount !== s.giftCount) staleFYs.push(s.fiscalYear);
      }
    }

    // Leg 4: the Annual Giving Summary board items themselves, fetched by the item ids
    // annual_summaries recorded when syncAnnualSummaryBoard wrote them. Catches staff
    // edits (or deletions) on the board that D1 knows nothing about.
    const { annualSummaryBoardId, annualSummaryColumns } = deps.config.custodian;
    const withItems = summaries.filter((s) => s.mondayItemId !== null);
    if (annualSummaryBoardId !== null && annualSummaryColumns !== null && withItems.length > 0) {
      const board = await deps.mondayClient.getItemsColumnsText(
        withItems.map((s) => s.mondayItemId!), [annualSummaryColumns.total, annualSummaryColumns.giftCount]);
      for (const s of withItems) {
        summaryItemsChecked++;
        const cols = board.get(s.mondayItemId!);
        const totalText = cols?.get(annualSummaryColumns.total) ?? null;
        const boardCents = totalText === null ? null : Math.round(Number(totalText) * 100);
        const countText = cols?.get(annualSummaryColumns.giftCount) ?? null;
        const boardCount = countText === null ? null : Number(countText);
        if (boardCents !== s.totalCents || boardCount !== s.giftCount) {
          summaryBoardMismatches.push({ fiscalYear: s.fiscalYear, ledgerCents: s.totalCents, boardCents });
        }
      }
    }

    // Legs 5/6: attributed giving per affiliation and Organizational Giving per person,
    // against the affiliation model's own columns — only meaningful once config.affiliations
    // is set up, and only worth the extra subrequests on the final slice like legs 3/4.
    if (deps.config.affiliations !== null) {
      const { columns } = deps.config.affiliations;

      // Leg 5: every affiliation's attributed total vs its board's attributedGiving column.
      const ledgerByAffiliation = await deps.gifts.attributedTotalsAll(receivedStatusLabel);
      const affiliationIds = [...ledgerByAffiliation.keys()].sort();
      const affResults = await compareCents(
        deps.mondayClient, affiliationIds, columns.attributedGiving,
        (id) => ledgerByAffiliation.get(id)!.cents);
      affiliationMismatches.push(...affResults.map((m) =>
        ({ affiliationItemId: m.id, ledgerCents: m.ledgerCents, mondayCents: m.mondayCents })));

      // Leg 6: every person's Organizational Giving vs their own board's organizationalGiving
      // column — grouped by board since that column id (and its existence) is per-board.
      const ledgerByPerson = await deps.gifts.organizationalGivingAll(receivedStatusLabel);
      const personIdsByBoard = new Map<string, string[]>();
      for (const [personId, t] of ledgerByPerson) {
        const list = personIdsByBoard.get(t.personBoardId) ?? [];
        list.push(personId);
        personIdsByBoard.set(t.personBoardId, list);
      }
      for (const [personBoardId, personIds] of personIdsByBoard) {
        const column = ownerColumnsByBoard[personBoardId]?.organizationalGiving;
        if (!column) continue; // e.g. an Organizations board, which has no driven-giving concept
        const results = await compareCents(
          deps.mondayClient, personIds.sort(), column, (id) => ledgerByPerson.get(id)!.cents);
        organizationalMismatches.push(...results.map((m) =>
          ({ personItemId: m.id, ledgerCents: m.ledgerCents, mondayCents: m.mondayCents })));
      }
    }
  }

  const ok = mismatches.length === 0 && projectionMismatches.length === 0
    && staleFYs.length === 0 && summaryBoardMismatches.length === 0
    && affiliationMismatches.length === 0 && organizationalMismatches.length === 0;
  return {
    ok,
    summary: ok
      ? `${compared} owners reconciled clean` +
        (remaining > 0
          ? ` — ${remaining} remain, continuing next run`
          : `, ${summariesChecked} annual summaries and ${summaryItemsChecked} summary board item(s) current`)
      : `${mismatches.length} owner mismatch(es), ${projectionMismatches.length} gift-ledger projection mismatch(es), ` +
        `${staleFYs.length} stale annual summary(ies), ${summaryBoardMismatches.length} summary board mismatch(es), ` +
        `${affiliationMismatches.length} affiliation mismatch(es), ${organizationalMismatches.length} organizational giving mismatch(es)`,
    detail: { compared, remaining, cursor: slice.at(-1) ?? cursor,
      mismatches: mismatches.slice(0, 20), mismatchCount: mismatches.length,
      projectionMismatches: projectionMismatches.slice(0, 20),
      projectionMismatchCount: projectionMismatches.length, truncatedProjections,
      staleFYs, summaryBoardMismatches, summaryItemsChecked,
      affiliationMismatches: affiliationMismatches.slice(0, 20), affiliationMismatchCount: affiliationMismatches.length,
      organizationalMismatches: organizationalMismatches.slice(0, 20), organizationalMismatchCount: organizationalMismatches.length },
  };
}

// Shared by legs 5 and 6: read one Monday column for a batch of item ids (chunked at 100,
// Monday's items(ids:) cap) and diff it in rounded cents against the ledger side.
async function compareCents(
  mondayClient: CustodianMondayClient,
  ids: string[],
  columnId: string,
  ledgerCentsOf: (id: string) => number,
): Promise<{ id: string; ledgerCents: number; mondayCents: number | null }[]> {
  const mismatches: { id: string; ledgerCents: number; mondayCents: number | null }[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const monday = await mondayClient.getItemsColumnsText(chunk, [columnId]);
    for (const id of chunk) {
      const text = monday.get(id)?.get(columnId) ?? null;
      const mondayCents = text === null ? null : Math.round(Number(text) * 100);
      const ledgerCents = ledgerCentsOf(id);
      if (mondayCents !== ledgerCents) mismatches.push({ id, ledgerCents, mondayCents });
    }
  }
  return mismatches;
}

async function alert(deps: CustodianDeps, message: string): Promise<void> {
  console.error(message);
  const { alertItemId } = deps.config.custodian;
  if (alertItemId === null) return;
  try {
    await deps.mondayClient.createUpdate(alertItemId, message);
  } catch (err) {
    console.error(`custodian alert: posting to Monday item ${alertItemId} failed: ${String(err)}`);
  }
}
