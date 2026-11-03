import type { GiftsStore } from '../db/gifts';
import type { PendingStore } from '../db/pending';
import type { VolunteerActivityStore } from '../db/volunteerActivity';
import type { OwnerRecomputesStore } from '../db/ownerRecomputes';
import type { RollCallCreditsStore } from '../db/rollCallCredits';
import type { RegistrationRecord, HistoricalShiftRecord, RecurringGiftRecord, DonationCreditRecord, ItemColumns } from '../monday/client';
import type { DonationRollupsConfig, FiscalYearConfig, RecomputeQueueMessage, VolunteerBoardConfig,
  HistoricalVolunteerBoardConfig, RecurringGiftsConfig, RollCallConfig } from '../types';
import { currentFiscalYear, localDateParts } from '../rollups/compute';
import { parseGiftLedgerJson } from '../projections/giftHistory';
import { runClassify } from './classify';
import { runMembership, type MembershipDetail } from './membership';
import { runRecurring } from './recurring';
import { runRollCall } from './rollcall';
import { formatCents, parseAmountCents } from '../money';
import { runDisposition } from '../flags';
import { custodianDepsFor, type BatchSkipContext } from '../writeSwitch';

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
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>,
    opts?: { createLabelsIfMissing?: boolean }): Promise<void>;
  // requireBoard: throw when Monday returns no such board (deleted, or the token can't see it)
  // rather than read it as empty.
  pageItemsColumnsText(boardId: number, columnIds: string[], cursor: string | null, opts?: { requireBoard?: boolean }):
    Promise<{ items: ItemColumns[]; cursor: string | null }>;
  pageRegistrations(board: VolunteerBoardConfig, cursor: string | null): Promise<{ items: RegistrationRecord[]; cursor: string | null }>;
  pageHistoricalShifts(board: HistoricalVolunteerBoardConfig, cursor: string | null): Promise<{ items: HistoricalShiftRecord[]; cursor: string | null }>;
  getItemsBoardIds(itemIds: string[]): Promise<Map<string, string>>;
  pageRecurringGifts(board: RecurringGiftsConfig, cursor: string | null): Promise<{ items: RecurringGiftRecord[]; cursor: string | null }>;
  // Throws when Monday returns no such board. fiscalYearStartMonth derives a blank Fiscal Year
  // Ending from the Date, as getDonationsByIds does.
  pageDonationCredits(cfg: RollCallConfig['donations'], cursor: string | null, fiscalYearStartMonth: number):
    Promise<{ items: DonationCreditRecord[]; cursor: string | null }>;
  // A missing id is a deleted item.
  getItemsState(itemIds: string[]): Promise<Map<string, 'active' | 'archived' | 'deleted'>>;
  // The Donor Roll Call board (the `rollcall` duty). createGroup and createItemInGroup aren't
  // idempotent: one that may have committed throws AmbiguousWriteError.
  listGroups(boardId: number): Promise<{ id: string; title: string }[]>;
  createGroup(boardId: number, title: string): Promise<string>;
  updateGroupTitle(boardId: number, groupId: string, title: string): Promise<void>;
  createItemInGroup(boardId: number, groupId: string, name: string, columnValues: Record<string, unknown>): Promise<string>;
  moveItemToGroup(itemId: string, groupId: string): Promise<void>;
  deleteItem(itemId: string): Promise<void>;
}

export interface CustodianDeps {
  gifts: GiftsStore;
  pending: PendingStore;
  volunteers: VolunteerActivityStore;
  recomputes: OwnerRecomputesStore;
  rollCallCredits: RollCallCreditsStore;
  mondayClient: CustodianMondayClient;
  queue: { sendBatch(messages: RecomputeQueueMessage[]): Promise<void> };
  config: DonationRollupsConfig;
  now?: Date;
}

export interface DutyReport { ok: boolean; summary: string; detail?: unknown }

export const DUTIES = ['archive', 'capacity', 'sweep', 'reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall'] as const;
// force: rollcall only, past its mass-delete guard.
export interface DutyOptions { all?: boolean; since?: string; force?: boolean }
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
// The sweep's and archive's start dates follow config "fiscalYear" (issue #27): day 1 and day 15
// of the fiscal start month (SVBC: July 1 and July 15), read in the org's time zone.
export function dutiesForDate(
  now: Date, fiscalYear: FiscalYearConfig, lastRuns: { duty: string; report: unknown }[] = [],
): Duty[] {
  const { year, month, day } = localDateParts(now, fiscalYear.timeZone);
  // requeue: fix 5; classify: chartable labels; membership: 13-month anniversaries; recurring: Has
  // Active Recurring Gift; rollcall: the Donor Roll Call board — all nightly
  const duties: Duty[] = ['reconcile', 'requeue', 'classify', 'membership', 'recurring', 'rollcall'];
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 1) duties.push('capacity');
  if (month === fiscalYear.startMonth && day === 1) duties.push('sweep');
  if (month === fiscalYear.startMonth && day === 15) duties.push('archive');
  for (const duty of ['sweep', 'archive', 'classify', 'rollcall'] as const) {
    if (duties.includes(duty)) continue;
    const last = lastRuns.find((r) => r.duty === duty)?.report as
      { detail?: { remaining?: number } } | undefined;
    if ((last?.detail?.remaining ?? 0) > 0) duties.push(duty);
  }
  return duties;
}

// The daily cron (index.ts scheduled()). The write switch's mode, read once for the run, decides
// whether today's duties run live (`on`), run against recording proxies (`off` — Monday writes,
// queue sends and D1 bookkeeping, recordRun included, become skip lines, so no cursor moves), or
// don't run at all (`hold`, `unknown` — one log line; a sliced duty continues on the first live
// run, since nothing was recorded).
export async function runScheduled(deps: CustodianDeps, gate: BatchSkipContext): Promise<void> {
  const disposition = runDisposition(gate.mode);
  if (disposition === 'skip') {
    console.warn(`donation-rollups custodian: write mode is "${gate.mode}"; skipping today's duties, nothing recorded`);
    return;
  }
  const now = deps.now ?? new Date();
  const d = custodianDepsFor(disposition, deps, { ...gate, deliveryId: `custodian:${now.toISOString()}` });
  const label = disposition === 'dry-run' ? ' (dry run)' : '';
  for (const duty of dutiesForDate(now, d.config.fiscalYear, await d.gifts.lastRuns())) {
    const report = await runDuty(duty, d);
    console.log(`custodian ${duty}${label}: ${report.ok ? 'ok' : 'ATTENTION'} — ${report.summary}`);
  }
}

export async function runDuty(duty: Duty, deps: CustodianDeps, opts: DutyOptions = {}): Promise<DutyReport> {
  const now = deps.now ?? new Date();
  let report: DutyReport;
  try {
    report =
      duty === 'archive' ? await runArchive(deps, now)
      : duty === 'capacity' ? await runCapacity(deps)
      : duty === 'sweep' ? await runSweep(deps)
      : duty === 'requeue' ? await runRequeue(deps, now)
      : duty === 'classify' ? await runClassify(deps.mondayClient, deps.config)
      : duty === 'recurring' ? await runRecurring(deps)
      : duty === 'rollcall' ? await runRollCall(deps, now, { force: opts.force ?? false })
      : duty === 'membership' ? await runMembership(deps, now, { all: opts.all ?? false, since: opts.since ?? null },
          ((await deps.gifts.lastRuns()).find((r) => r.duty === 'membership')?.report as { detail?: MembershipDetail } | undefined)?.detail ?? null)
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
  const cutoffFY = currentFiscalYear(now, deps.config.fiscalYear) - activeFiscalYears + 1;
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
      .map(([t, cents]) => `${t}: $${formatCents(cents)}`)
      .join('\n');
    const columnValues: Record<string, unknown> = {
      [annualSummaryColumns.fiscalYear]: String(s.fiscalYear),
      [annualSummaryColumns.total]: formatCents(s.totalCents),
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
  // An empty listing means the workspace id is wrong (0 is the production placeholder) or the
  // token cannot see the workspace — either way the alarm is blind, which must read as
  // ATTENTION, not "all 0 boards under 80%".
  if (boards.length === 0) {
    return {
      ok: false,
      summary: `no boards visible in workspace ${workspaceId} — capacity alarm is blind (wrong workspaceId or token scope)`,
      detail: { checked: 0, over: [] },
    };
  }
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
      .map((r) => ({ ...(r.kind === 'registration' ? { kind: r.kind } : {}), donationItemId: r.donationItemId, donationBoardId: r.donationBoardId })));
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

// Nightly reconciliation — all six legs docs/20 promises:
//   1. ledger vs Monday's Lifetime Giving column (per owner, sliced),
//   2. ledger vs the Gift Ledger JSON projection column (per owner, same subrequests),
//   3. ledger vs D1's materialized annual_summaries (once the owner walk is caught up),
//   4. annual_summaries vs the Annual Giving Summary board items (same),
//   5. per-affiliation attributed giving vs its board's column (sliced separately, only
//      once the owner walk is caught up AND idle — see below),
//   6. per-person Organizational Giving vs each person board's column (same, after leg 5).
// Mismatches alert; a human decides which side is right (usually the ledger — unless a
// deliberate staff edit simply hasn't landed yet). Sliced like the sweep: Monday caps
// items(ids:) at 100 and the Free plan caps subrequests at 50 per invocation, so each run
// covers RECONCILE_OWNERS_PER_RUN owners and the nightly cron walks the full owner set
// across consecutive nights (2 nights at current volume). Both owner columns ride the
// same batched query (getItemsColumnsText), so leg 2 adds no subrequests; leg 4 adds at
// most one per 100 closed years, only once the owner walk is caught up. Legs 5/6 are
// sliced and cursored independently of the owner walk and only ever run in an invocation
// whose owner slice is empty (never stacked on an owner slice's own subrequests) — see the
// comment above the legs 5/6 block for why.
const RECONCILE_OWNERS_PER_RUN = 4_000;
// Legs 5/6 are sliced separately from the owner walk (see below) — each covers 20
// getItemsColumnsText calls per run, well inside the Free plan's 50-subrequest cap even
// stacked together, but NOT stacked on top of an owner slice (up to 40 calls for legs 1/2).
export const RECONCILE_AFFILIATIONS_PER_RUN = 2_000;
export const RECONCILE_PERSONS_PER_RUN = 2_000;
async function runReconcile(deps: CustodianDeps): Promise<DutyReport> {
  const { receivedStatusLabel, ownerColumnsByBoard } = deps.config.donationRollups;
  const ledger = await deps.gifts.ownerTotals(receivedStatusLabel);

  const lastRuns = await deps.gifts.lastRuns();
  const last = lastRuns.find((r) => r.duty === 'reconcile')?.report as
    { detail?: {
        cursor?: string; remaining?: number;
        affiliationCursor?: string; affiliationRemaining?: number;
        personCursor?: string; personRemaining?: number;
      } } | undefined;
  const cursor = (last?.detail?.remaining ?? 0) > 0 ? (last?.detail?.cursor ?? '') : '';

  const allOwners = [...ledger.keys()].sort();
  const startIdx = cursor === '' ? 0 : allOwners.findIndex((o) => o > cursor);
  const slice = startIdx < 0 ? [] : allOwners.slice(startIdx, startIdx + RECONCILE_OWNERS_PER_RUN);
  const ownerRemaining = startIdx < 0 ? 0 : allOwners.length - startIdx - slice.length;

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

      // Leg 1: the Lifetime Giving column. Rows written before issue #27 hold float noise
      // (714.9300000000001) — parseAmountCents rounds it to cents from the decimal string.
      const lifetimeText = cols?.get(columns.lifetimeGiving) ?? null;
      const mondayCents = parseAmountCents(lifetimeText);
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
  let affiliationRemaining = 0;
  let affiliationCursor = '';
  let personRemaining = 0;
  let personCursor = '';
  if (ownerRemaining === 0) {
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
        const boardCents = parseAmountCents(totalText);
        const countText = cols?.get(annualSummaryColumns.giftCount) ?? null;
        const boardCount = countText === null ? null : Number(countText);
        if (boardCents !== s.totalCents || boardCount !== s.giftCount) {
          summaryBoardMismatches.push({ fiscalYear: s.fiscalYear, ledgerCents: s.totalCents, boardCents });
        }
      }
    }

    // Legs 5/6: attributed giving per affiliation and Organizational Giving per person,
    // against the affiliation model's own columns — only meaningful once config.affiliations
    // is set up. Unlike legs 3/4 (small: D1-only or one summary-board call), legs 5/6 run
    // tens of getItemsColumnsText calls each at production volume, so — unlike legs 3/4 —
    // they never run in the same invocation as an owner slice (up to 40 calls for legs 1/2
    // alone; see the task-8 review finding). They're sliced/cursored across runs like the
    // owner walk itself, and only spend Monday subrequests once `slice` (the owner slice) is
    // empty, i.e. the run AFTER the owner walk already finished. The run that finishes the
    // owner walk itself (ownerRemaining hits 0 but `slice` is still non-empty this run) still
    // reports accurate outstanding counts via the cheap D1 reads below (cap 0 → no Monday
    // calls) — that keeps affiliationRemaining/personRemaining > 0, which keeps the combined
    // `remaining` below > 0, which parks the owner cursor (see `cursor` above) until legs 5/6
    // catch up on later runs.
    if (deps.config.affiliations !== null) {
      const { columns } = deps.config.affiliations;

      // Leg 5: every affiliation's attributed total vs its board's attributedGiving column,
      // resumed from affiliationCursor when the last run left work outstanding.
      const ledgerByAffiliation = await deps.gifts.attributedTotalsAll(receivedStatusLabel);
      const affiliationIds = [...ledgerByAffiliation.keys()].sort();
      const affiliationCursorIn = (last?.detail?.affiliationRemaining ?? 0) > 0
        ? (last?.detail?.affiliationCursor ?? '') : '';
      const affSliced = sliceByCursor(affiliationIds, affiliationCursorIn,
        slice.length === 0 ? RECONCILE_AFFILIATIONS_PER_RUN : 0);
      affiliationRemaining = affSliced.remaining;
      affiliationCursor = affSliced.cursorOut;
      if (affSliced.slice.length > 0) {
        const affResults = await compareCents(
          deps.mondayClient, affSliced.slice, columns.attributedGiving,
          (id) => ledgerByAffiliation.get(id)!.cents);
        affiliationMismatches.push(...affResults.map((m) =>
          ({ affiliationItemId: m.id, ledgerCents: m.ledgerCents, mondayCents: m.mondayCents })));
      }

      // Leg 6: every person's Organizational Giving vs their own board's organizationalGiving
      // column — grouped by board since that column id (and its existence) is per-board.
      // Only spends Monday subrequests once leg 5 has fully caught up THIS run; otherwise it
      // waits for a later run (same subrequest-budget reasoning as above).
      const ledgerByPerson = await deps.gifts.organizationalGivingAll(receivedStatusLabel);
      const personIds = [...ledgerByPerson.keys()].sort();
      const personCursorIn = (last?.detail?.personRemaining ?? 0) > 0
        ? (last?.detail?.personCursor ?? '') : '';
      const personSliced = sliceByCursor(personIds, personCursorIn,
        affiliationRemaining === 0 ? RECONCILE_PERSONS_PER_RUN : 0);
      personRemaining = personSliced.remaining;
      personCursor = personSliced.cursorOut;
      if (personSliced.slice.length > 0) {
        const personIdsByBoard = new Map<string, string[]>();
        for (const personId of personSliced.slice) {
          const boardId = ledgerByPerson.get(personId)!.personBoardId;
          const list = personIdsByBoard.get(boardId) ?? [];
          list.push(personId);
          personIdsByBoard.set(boardId, list);
        }
        for (const [personBoardId, personIdsForBoard] of personIdsByBoard) {
          const column = ownerColumnsByBoard[personBoardId]?.organizationalGiving;
          if (!column) {
            // e.g. an Organizations board, which has no driven-giving concept — warn once per
            // run rather than silently skipping, matching the consumer's own warning for the
            // same condition (processBatch.ts recomputeAffiliations).
            console.warn(`donation-rollups custodian: no organizationalGiving column for board "${personBoardId}" — reconcile leg 6 skipped it`);
            continue;
          }
          const results = await compareCents(
            deps.mondayClient, personIdsForBoard, column, (id) => ledgerByPerson.get(id)!.cents);
          organizationalMismatches.push(...results.map((m) =>
            ({ personItemId: m.id, ledgerCents: m.ledgerCents, mondayCents: m.mondayCents })));
        }
      }
    }
  }

  // The combined remaining across all three sliced legs — this, not ownerRemaining alone, is
  // what next run's owner-cursor decision (above) reads back, so the owner walk stays parked
  // until legs 5/6 finish too (see the comment on the legs 5/6 block).
  const remaining = ownerRemaining + affiliationRemaining + personRemaining;
  const legsFiveSixIncomplete = affiliationRemaining > 0 || personRemaining > 0;
  const ok = mismatches.length === 0 && projectionMismatches.length === 0
    && staleFYs.length === 0 && summaryBoardMismatches.length === 0
    && affiliationMismatches.length === 0 && organizationalMismatches.length === 0;
  return {
    ok,
    summary: ok
      ? ownerRemaining > 0
        ? `${compared} owners reconciled clean — ${ownerRemaining} remain, continuing next run`
        : legsFiveSixIncomplete
          ? `${compared} owners reconciled clean, ${summariesChecked} annual summaries and ${summaryItemsChecked} summary board item(s) current` +
            ` — ${affiliationRemaining} affiliations and ${personRemaining} people remain, continuing next run`
          : `${compared} owners reconciled clean, ${summariesChecked} annual summaries and ${summaryItemsChecked} summary board item(s) current`
      : `${mismatches.length} owner mismatch(es), ${projectionMismatches.length} gift-ledger projection mismatch(es), ` +
        `${staleFYs.length} stale annual summary(ies), ${summaryBoardMismatches.length} summary board mismatch(es), ` +
        `${affiliationMismatches.length} affiliation mismatch(es), ${organizationalMismatches.length} organizational giving mismatch(es)`,
    detail: { compared, remaining, cursor: slice.at(-1) ?? cursor,
      mismatches: mismatches.slice(0, 20), mismatchCount: mismatches.length,
      projectionMismatches: projectionMismatches.slice(0, 20),
      projectionMismatchCount: projectionMismatches.length, truncatedProjections,
      staleFYs, summaryBoardMismatches, summaryItemsChecked,
      affiliationMismatches: affiliationMismatches.slice(0, 20), affiliationMismatchCount: affiliationMismatches.length,
      affiliationRemaining, affiliationCursor,
      organizationalMismatches: organizationalMismatches.slice(0, 20), organizationalMismatchCount: organizationalMismatches.length,
      personRemaining, personCursor },
  };
}

// Shared by legs 5 and 6: page through a sorted id list by cursor, capped at `cap` ids this
// run. cap === 0 reports the true outstanding count (and leaves the cursor untouched) without
// consuming any of it — used when the owner slice wasn't empty this run, so legs 5/6 must not
// spend Monday subrequests yet (see runReconcile).
function sliceByCursor(ids: string[], cursorIn: string, cap: number): { slice: string[]; remaining: number; cursorOut: string } {
  const startIdx = cursorIn === '' ? 0 : ids.findIndex((id) => id > cursorIn);
  const available = startIdx < 0 ? [] : ids.slice(startIdx);
  const slice = available.slice(0, cap);
  return { slice, remaining: available.length - slice.length, cursorOut: slice.at(-1) ?? cursorIn };
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
      const mondayCents = parseAmountCents(text);
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
