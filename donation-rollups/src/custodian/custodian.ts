import type { GiftsStore } from '../db/gifts';
import type { DonationRollupsConfig, RecomputeQueueMessage } from '../types';
import { currentFiscalYear } from '../rollups/compute';

// The custodian (docs/20 §5.3 in the private planning repo): the four recurring duties that
// keep the archive-in-place Donations board and its projections healthy. Each duty is pure
// enough to run from cron OR an authenticated HTTP route, returns a JSON report, records
// itself in custodian_runs (the runbook surface), and alerts when it found something a human
// should look at. Nothing here auto-heals silently — mismatches are reported, not patched.

export interface BoardCapacity { id: string; name: string; itemsCount: number; itemsLimit: number | null }

export interface CustodianMondayClient {
  archiveItem(itemId: string): Promise<void>;
  listWorkspaceBoards(workspaceId: number): Promise<BoardCapacity[]>;
  // Numeric column value per item, batched by id — used to read owners' Lifetime Giving.
  getItemsColumnNumber(itemIds: string[], columnId: string): Promise<Map<string, number | null>>;
  createUpdate(itemId: number, body: string): Promise<void>;
  createItem(boardId: number, itemName: string, columnValues: Record<string, unknown>): Promise<string>;
  changeColumnValues(boardId: number, itemId: string, columnValues: Record<string, unknown>): Promise<void>;
}

export interface CustodianDeps {
  gifts: GiftsStore;
  mondayClient: CustodianMondayClient;
  queue: { sendBatch(messages: RecomputeQueueMessage[]): Promise<void> };
  config: DonationRollupsConfig;
  now?: Date;
}

export interface DutyReport { ok: boolean; summary: string; detail?: unknown }

export const DUTIES = ['archive', 'capacity', 'sweep', 'reconcile'] as const;
export type Duty = (typeof DUTIES)[number];

// Cron schedule, decided by date so one daily trigger covers everything:
// reconcile nightly; capacity every Monday; the July fiscal-year sweep on July 1 (docs/20:
// first week — closes the This/Last Year staleness gap); the year-end archive run on July 15,
// after the sweep's recomputes have settled the new fiscal-year splits.
export function dutiesForDate(now: Date): Duty[] {
  const duties: Duty[] = ['reconcile'];
  if (now.getUTCDay() === 1) duties.push('capacity');
  if (now.getUTCMonth() === 6 && now.getUTCDate() === 1) duties.push('sweep');
  if (now.getUTCMonth() === 6 && now.getUTCDate() === 15) duties.push('archive');
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

// Nightly reconciliation: ledger vs Monday's Lifetime Giving column, and ledger vs the
// materialized annual summaries. Mismatches alert; a human decides which side is right
// (usually the ledger — unless a deliberate staff edit simply hasn't landed yet). Sliced
// like the sweep: Monday caps items(ids:) at 100 and the Free plan caps subrequests at 50
// per invocation, so each run covers RECONCILE_OWNERS_PER_RUN owners and the nightly cron
// walks the full owner set across consecutive nights (2 nights at current volume), checking
// the annual summaries on the wrap-around slice.
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
  let compared = 0;
  for (const [boardId, ownerIds] of byBoard) {
    const columns = ownerColumnsByBoard[boardId];
    if (!columns) continue; // an owner board outside config would already fail recompute loudly
    const monday = await deps.mondayClient.getItemsColumnNumber(ownerIds, columns.lifetimeGiving);
    for (const ownerId of ownerIds) {
      compared++;
      const mondayValue = monday.get(ownerId);
      // Monday stores floats (714.9300000000001) — compare in rounded cents.
      const mondayCents = mondayValue === null || mondayValue === undefined ? null : Math.round(mondayValue * 100);
      const ledgerCents = ledger.get(ownerId)!.cents;
      if (mondayCents !== ledgerCents) mismatches.push({ ownerItemId: ownerId, ledgerCents, mondayCents });
    }
  }

  // Annual summaries drift only under audit edits that bypassed the archive run — checked
  // once per full pass, on the final slice.
  const staleFYs: number[] = [];
  let summariesChecked = 0;
  if (remaining === 0) {
    const summaries = await deps.gifts.getAnnualSummaries();
    summariesChecked = summaries.length;
    if (summaries.length > 0) {
      const maxFY = Math.max(...summaries.map((s) => s.fiscalYear));
      const fresh = new Map(
        (await deps.gifts.fiscalYearTotals(receivedStatusLabel, maxFY + 1)).map((t) => [t.fiscalYear, t]));
      for (const s of summaries) {
        const f = fresh.get(s.fiscalYear);
        if (!f || f.totalCents !== s.totalCents || f.giftCount !== s.giftCount) staleFYs.push(s.fiscalYear);
      }
    }
  }

  const ok = mismatches.length === 0 && staleFYs.length === 0;
  return {
    ok,
    summary: ok
      ? `${compared} owners reconciled clean` +
        (remaining > 0 ? ` — ${remaining} remain, continuing next run` : `, ${summariesChecked} annual summaries current`)
      : `${mismatches.length} owner mismatch(es), ${staleFYs.length} stale annual summary(ies)`,
    detail: { compared, remaining, cursor: slice.at(-1) ?? cursor,
      mismatches: mismatches.slice(0, 20), mismatchCount: mismatches.length, staleFYs },
  };
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
