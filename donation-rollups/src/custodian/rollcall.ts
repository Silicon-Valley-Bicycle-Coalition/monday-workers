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
import { refreshCreditsWithRows } from '../rollcall/credits';
import type { CreditRow } from '../db/rollCallCredits';
import { applySync, boardItemFrom, distinctItems, groupYearFrom, planSync, type BoardItem } from '../rollcall/sync';
import type { ItemColumns } from '../monday/client';
import type { RollCallConfig } from '../types';

export interface RollCallDetail {
  rows: number;
  unplaced: { gifts: number; cents: number };
  credits: { upserted: number; removed: number; archived: number; badRecognitionYears?: string[] };
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
// A credits row's Recognition Fiscal Year replaces the gift's year, whichever copy it counts from,
// and a blank ledger Amount takes the row's in-kind cents (spec §10): still one gift, one year.
// allCredits: the credits table as the run's refresh left it; read from D1 when not given.
export async function rollCallGifts(deps: CustodianDeps, cfg: RollCallConfig, currentFY: number, allCredits?: CreditRow[]):
  Promise<{ gifts: CountedGift[]; pendingLedger: number }> {
  // A gift of zero or negative cents never counts (donor-roll-call.mjs skips it too): it would
  // make a $0 row, or add to a row's Gifts without adding to its Total.
  const counted = (status: string, giftType: string | null, fiscalYear: number, cents: number) => fiscalYear <= currentFY
    && fiscalYear >= cfg.firstFiscalYear && cents > 0 && RECEIVED_LABELS.includes(status) && !(giftType !== null && cfg.excludedGiftTypes.includes(giftType));
  // Who a gift is credited to comes from every credits row, before any counting filter: a gift
  // with a named credit (anonymous, Matched By, unplaced) is never its ledger owner's, even when
  // that row doesn't count tonight ($0, not received, another year). Fail closed on the donor's name.
  allCredits ??= await deps.rollCallCredits.all();
  const creditById = new Map(allCredits.map((r) => [r.giftItemId, r]));
  const yearOf = (r: CreditRow | undefined, own: number) => r?.recognitionFiscalYear ?? own;
  const moved = (year: number, own: number) => (year !== own ? { ownFiscalYear: own } : {});
  const credits = allCredits.filter((r) => counted(r.status, r.giftType, yearOf(r, r.fiscalYear), r.amountCents));
  // A ledger gift dated before the covered years is read only when its row moves it into them.
  const earlier = allCredits.filter((r) => r.credit === null && r.recognitionFiscalYear !== null
    && r.recognitionFiscalYear >= cfg.firstFiscalYear && r.fiscalYear < cfg.firstFiscalYear).map((r) => r.giftItemId);

  const gifts: CountedGift[] = [];
  const inLedger = new Set<string>();
  for (const g of await deps.gifts.countedGifts(cfg.firstFiscalYear, earlier)) {
    const row = creditById.get(g.mondayItemId);
    const year = yearOf(row, g.fiscalYear);
    // The ledger's Amount when it has one; a blank one takes the row's in-kind cents.
    const cents = g.amountCents > 0 ? g.amountCents : row?.credit === null ? row.amountCents : g.amountCents;
    if (!counted(g.status, g.giftType, year, cents)) continue;
    inLedger.add(g.mondayItemId);
    if (row !== undefined && row.credit !== null) continue;
    gifts.push({ giftItemId: g.mondayItemId, fiscalYear: year, cents,
      credit: `item:${g.ownerItemId}`, unmatchedMatch: row?.unmatchedMatch ?? false, ...moved(year, g.fiscalYear) });
  }
  let pendingLedger = 0;
  for (const r of credits) {
    if (r.credit === null) {
      if (!inLedger.has(r.giftItemId)) pendingLedger++;
      continue;
    }
    const year = yearOf(r, r.fiscalYear);
    gifts.push({ giftItemId: r.giftItemId, fiscalYear: year, cents: r.amountCents, credit: r.credit,
      unmatchedMatch: r.unmatchedMatch, ...moved(year, r.fiscalYear) });
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

// The donor boards' columns readDonors pages: People and People (Historical), then Organizations.
// Exported for the custodian's shared board read (boardReads.ts, issue GL#90).
export function donorReadColumns(cfg: RollCallConfig): { boardId: number; columnIds: string[] }[] {
  // Addresses stay out of memory and the Review Note until the board has a column for them (spec §11).
  const mailingOn = cfg.columns.mailingAddress !== undefined;
  const mailingColumns = (...ids: (string | undefined)[]): string[] => (mailingOn ? ids.filter((id) => id !== undefined) : []);
  const org = cfg.organizations;
  return [
    ...Object.entries(cfg.people).map(([boardId, cols]) => ({ boardId: Number(boardId),
      columnIds: [cols.householdId, cols.householdGreeting, cols.householdEmail, cols.doNotSolicit, cols.dontList,
        ...mailingColumns(cols.address, cols.doNotMail)] })),
    { boardId: org.boardId, columnIds: [org.columns.recognitionName, org.columns.dontList, ...mailingColumns(org.columns.address)] },
  ];
}

// People and People (Historical), then Organizations, keyed by item id.
async function readDonors(deps: CustodianDeps, cfg: RollCallConfig): Promise<Map<string, DonorRecord>> {
  const donors = new Map<string, DonorRecord>();
  const mailingOn = cfg.columns.mailingAddress !== undefined;
  const reads = new Map(donorReadColumns(cfg).map((r) => [r.boardId, r.columnIds]));
  for (const [boardId, cols] of Object.entries(cfg.people)) {
    for (const item of await pageAll(deps, Number(boardId), reads.get(Number(boardId))!)) {
      const text = (id: string) => item.text.get(id) ?? null;
      donors.set(item.id, { kind: 'person', name: item.name ?? '', recognitionName: text(cols.householdGreeting) ?? '',
        householdId: text(cols.householdId) ?? '', householdEmail: text(cols.householdEmail) ?? '',
        doNotSolicit: isChecked(text(cols.doNotSolicit)), dontList: isChecked(text(cols.dontList)),
        mailingAddress: mailingOn && cols.address !== undefined ? text(cols.address) ?? '' : '',
        doNotMail: mailingOn && cols.doNotMail !== undefined && isChecked(text(cols.doNotMail)) });
    }
  }
  const org = cfg.organizations;
  for (const item of await pageAll(deps, org.boardId, reads.get(org.boardId)!)) {
    donors.set(item.id, { kind: 'organization', name: item.name ?? '',
      recognitionName: item.text.get(org.columns.recognitionName) ?? '', householdId: '', householdEmail: '',
      doNotSolicit: false, dontList: isChecked(item.text.get(org.columns.dontList) ?? null),
      mailingAddress: mailingOn && org.columns.address !== undefined ? item.text.get(org.columns.address) ?? '' : '',
      doNotMail: false });
  }
  return donors;
}

export async function runRollCall(deps: CustodianDeps, now: Date, opts: { force?: boolean } = {}): Promise<DutyReport> {
  const cfg = deps.config.donationRollups.rollCall;
  if (cfg === null) return { ok: true, summary: 'rollcall: not configured, skipped' };

  const currentFY = currentFiscalYear(now, deps.config.fiscalYear);
  const { summary: credits, rows: creditRows } = await refreshCreditsWithRows(deps, cfg, now.toISOString(), currentFY);
  const { gifts, pendingLedger } = await rollCallGifts(deps, cfg, currentFY, creditRows);
  const { rows, unplaced } = buildRollCall(gifts, await readDonors(deps, cfg));

  // Distinct by id: a paging race can repeat an item, which must neither delete it nor raise
  // the guard's 10% limit.
  const items: BoardItem[] = distinctItems((await pageAll(deps, cfg.boardId, Object.values(cfg.columns)))
    .map((item) => boardItemFrom(item, cfg.columns)));
  // Read once and handed to applySync (issue GL#90): planning writes nothing in between.
  const groups = await deps.mondayClient.listGroups(cfg.boardId);
  const groupYearById = new Map<string, number>();
  for (const g of groups) {
    const year = groupYearFrom(g.title);
    if (year !== null) groupYearById.set(g.id, year);
  }
  // Closed years past the archive cutoff: every gift in them is archived (custodian runArchive).
  const frozenYears = new Set<number>();
  for (let y = cfg.firstFiscalYear; y <= currentFY - deps.config.custodian.activeFiscalYears; y++) frozenYears.add(y);
  // Donors a Recognition Fiscal Year moved out of each year: positive news for a frozen year's row.
  const movedOut = new Map<number, Set<string>>();
  for (const g of gifts) {
    if (g.ownFiscalYear === undefined || !g.credit.startsWith('item:')) continue;
    let ids = movedOut.get(g.ownFiscalYear);
    if (ids === undefined) movedOut.set(g.ownFiscalYear, ids = new Set());
    ids.add(g.credit.slice(5));
  }
  const ops = planSync(rows, items, cfg.columns, frozenYears, groupYearById, movedOut);

  // Every delete counts, duplicate or gone: either kind can empty the board.
  const deletes = ops.filter((op) => op.op === 'delete').length;
  const limit = Math.max(DELETE_FLOOR, Math.floor(items.length / 10));
  const blocked = opts.force ? undefined
    : rows.length === 0 && items.length > 0 ? `computed no rows but the board has ${items.length}`
    : deletes > limit ? `${deletes} rows would be deleted, more than the limit of ${limit}`
    : undefined;
  const { applied, remaining } = blocked === undefined ? await applySync(deps, cfg, ops, currentFY, groups) : { applied: 0, remaining: ops.length };

  const detail: RollCallDetail = { rows: rows.length, unplaced, credits, pendingLedger, applied, remaining, ...(blocked ? { blocked } : {}) };
  const parts = [`rollcall: ${rows.length} rows`];
  if (blocked) parts.push(`NOT applied: ${blocked} — check the ledger and donor reads, then run with ?force=1 if it's right`);
  else parts.push(`applied ${applied} writes${remaining > 0 ? `, ${remaining} left for the next run` : ''}`);
  const bad = credits.badRecognitionYears ?? [];
  if (bad.length > 0) parts.push(`${bad.length} gift${bad.length === 1 ? ' has' : 's have'} a Recognition Fiscal Year that isn't a year (counted in their own year): ${bad.slice(0, 10).join(', ')}`);
  if (pendingLedger > 0) parts.push(`${pendingLedger} flagged gift${pendingLedger === 1 ? '' : 's'} waiting on the ledger, not counted yet`);
  if (unplaced.gifts > 0) parts.push(`${unplaced.gifts} gifts ($${formatCents(unplaced.cents)}) unplaced: no Donor on the People or Organizations boards`);
  return { ok: blocked === undefined && unplaced.gifts === 0, summary: parts.join('; '), detail };
}
