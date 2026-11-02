// The rollcall duty (donor roll call design, spec §5): keeps the Donor Roll Call board in step
// with the Donors ledger. Like the recurring duty, a full read each night and only differing
// cells written, capped per run with `remaining` reported (remaining > 0 re-runs it). Closed
// years recompute too, from the ledger's archived gifts, but planSync never drops a closed
// year's row unless a donor of it landed on another row.
import type { CustodianDeps, DutyReport } from './custodian';
import { isChecked } from './recurring';
import { currentFiscalYear } from '../rollups/compute';
import { formatCents } from '../money';
import { buildRollCall, RECEIVED_LABELS, type CountedGift, type DonorRecord } from '../rollcall/compute';
import { refreshCredits } from '../rollcall/credits';
import { applySync, boardItemFrom, groupYearFrom, planSync, type BoardItem } from '../rollcall/sync';
import type { ItemColumns } from '../monday/client';
import type { RollCallConfig } from '../types';

export interface RollCallDetail {
  rows: number;
  unplaced: { gifts: number; cents: number };
  credits: { upserted: number; removed: number; archived: number };
  // Credits rows that flag a gift for the ledger (credit null) whose ledger row isn't there yet:
  // the consumer hasn't recomputed it. Not counted tonight; normally clears by the next run.
  pendingLedger: number;
  applied: number;
  remaining: number;
  // Set when the mass-delete guard held back this run's writes.
  blocked?: string;
}

// The guard's floor: a run may delete up to this many rows (or 10% of the board, if more)
// without ?force=1. A failed upstream read must never empty the board.
const DELETE_FLOOR = 10;

// Each gift counts once (spec §5 step 1): a ledger gift is credited to its owner, unless its
// credits row names someone else; credits rows without a ledger gift (anonymous, Matched By,
// unplaced) count from the row. Sorted by gift id so names and member order are stable. Years
// after currentFY are ignored, so a typo'd year never gets a group of its own.
export async function rollCallGifts(deps: CustodianDeps, cfg: RollCallConfig, currentFY: number):
  Promise<{ gifts: CountedGift[]; pendingLedger: number }> {
  const counted = (status: string, giftType: string | null, fiscalYear: number) => fiscalYear <= currentFY
    && RECEIVED_LABELS.includes(status) && !(giftType !== null && cfg.excludedGiftTypes.includes(giftType));
  const credits = (await deps.rollCallCredits.all(cfg.firstFiscalYear)).filter((r) => counted(r.status, r.giftType, r.fiscalYear));
  const creditById = new Map(credits.map((r) => [r.giftItemId, r]));

  const gifts: CountedGift[] = [];
  const inLedger = new Set<string>();
  for (const g of await deps.gifts.countedGifts(cfg.firstFiscalYear)) {
    if (!counted(g.status, g.giftType, g.fiscalYear)) continue;
    inLedger.add(g.mondayItemId);
    const row = creditById.get(g.mondayItemId);
    if (row !== undefined && row.credit !== null) continue;
    gifts.push({ giftItemId: g.mondayItemId, fiscalYear: g.fiscalYear, cents: g.amountCents,
      credit: `item:${g.ownerItemId}`, unmatchedMatch: row?.unmatchedMatch ?? false });
  }
  let pendingLedger = 0;
  for (const r of credits) {
    if (r.credit === null) {
      if (!inLedger.has(r.giftItemId)) pendingLedger++;
      continue;
    }
    gifts.push({ giftItemId: r.giftItemId, fiscalYear: r.fiscalYear, cents: r.amountCents, credit: r.credit, unmatchedMatch: r.unmatchedMatch });
  }
  gifts.sort((a, b) => (a.giftItemId < b.giftItemId ? -1 : a.giftItemId > b.giftItemId ? 1 : 0));
  return { gifts, pendingLedger };
}

// requireBoard: a deleted board (or one the token can't see) must fail the run, not read as
// empty and pass the mass-delete guard.
async function pageAll(deps: CustodianDeps, boardId: number, columnIds: string[]): Promise<ItemColumns[]> {
  const items: ItemColumns[] = [];
  let cursor: string | null = null;
  do {
    const page = await deps.mondayClient.pageItemsColumnsText(boardId, columnIds, cursor, { requireBoard: true });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== null);
  return items;
}

// People and People (Historical), then Organizations, keyed by item id.
async function readDonors(deps: CustodianDeps, cfg: RollCallConfig): Promise<Map<string, DonorRecord>> {
  const donors = new Map<string, DonorRecord>();
  for (const [boardId, cols] of Object.entries(cfg.people)) {
    const ids = [cols.householdId, cols.householdGreeting, cols.householdEmail, cols.doNotSolicit, cols.dontList];
    for (const item of await pageAll(deps, Number(boardId), ids)) {
      const text = (id: string) => item.text.get(id) ?? null;
      donors.set(item.id, { kind: 'person', name: item.name ?? '', recognitionName: text(cols.householdGreeting) ?? '',
        householdId: text(cols.householdId) ?? '', householdEmail: text(cols.householdEmail) ?? '',
        doNotSolicit: isChecked(text(cols.doNotSolicit)), dontList: isChecked(text(cols.dontList)) });
    }
  }
  const org = cfg.organizations;
  for (const item of await pageAll(deps, org.boardId, [org.columns.recognitionName, org.columns.dontList])) {
    donors.set(item.id, { kind: 'organization', name: item.name ?? '',
      recognitionName: item.text.get(org.columns.recognitionName) ?? '', householdId: '', householdEmail: '',
      doNotSolicit: false, dontList: isChecked(item.text.get(org.columns.dontList) ?? null) });
  }
  return donors;
}

export async function runRollCall(deps: CustodianDeps, now: Date, opts: { force?: boolean } = {}): Promise<DutyReport> {
  const cfg = deps.config.donationRollups.rollCall;
  if (cfg === null) return { ok: true, summary: 'rollcall: not configured, skipped' };

  const currentFY = currentFiscalYear(now, deps.config.fiscalYear);
  const credits = await refreshCredits(deps, cfg, now.toISOString(), currentFY);
  const { gifts, pendingLedger } = await rollCallGifts(deps, cfg, currentFY);
  const { rows, unplaced } = buildRollCall(gifts, await readDonors(deps, cfg));

  const items: BoardItem[] = (await pageAll(deps, cfg.boardId, Object.values(cfg.columns)))
    .map((item) => boardItemFrom(item, cfg.columns));
  const groupYearById = new Map<string, number>();
  for (const g of await deps.mondayClient.listGroups(cfg.boardId)) {
    const year = groupYearFrom(g.title);
    if (year !== null) groupYearById.set(g.id, year);
  }
  // Closed years past the archive cutoff: every gift in them is archived (custodian runArchive).
  const frozenYears = new Set<number>();
  for (let y = cfg.firstFiscalYear; y <= currentFY - deps.config.custodian.activeFiscalYears; y++) frozenYears.add(y);
  const ops = planSync(rows, items, cfg.columns, frozenYears, groupYearById);

  const gone = ops.filter((op) => op.op === 'delete' && op.reason === 'gone').length;
  const limit = Math.max(DELETE_FLOOR, Math.floor(items.length / 10));
  const blocked = opts.force ? undefined
    : rows.length === 0 && items.length > 0 ? `computed no rows but the board has ${items.length}`
    : gone > limit ? `${gone} rows would be deleted, more than the limit of ${limit}`
    : undefined;
  const { applied, remaining } = blocked === undefined ? await applySync(deps, cfg, ops, currentFY) : { applied: 0, remaining: ops.length };

  const detail: RollCallDetail = { rows: rows.length, unplaced, credits, pendingLedger, applied, remaining, ...(blocked ? { blocked } : {}) };
  const parts = [`rollcall: ${rows.length} rows`];
  if (blocked) parts.push(`NOT applied: ${blocked} — check the ledger and donor reads, then run with ?force=1 if it's right`);
  else parts.push(`applied ${applied} writes${remaining > 0 ? `, ${remaining} left for the next run` : ''}`);
  if (pendingLedger > 0) parts.push(`${pendingLedger} flagged gift${pendingLedger === 1 ? '' : 's'} waiting on the ledger, not counted yet`);
  if (unplaced.gifts > 0) parts.push(`${unplaced.gifts} gifts ($${formatCents(unplaced.cents)}) unplaced: no Donor on the People or Organizations boards`);
  return { ok: blocked === undefined && unplaced.gifts === 0, summary: parts.join('; '), detail };
}
