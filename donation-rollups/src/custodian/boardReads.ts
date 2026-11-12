// One read of each shared board per cron run (issue #90). Membership, recurring and rollcall
// each paged the People boards in full every night, and classify and rollcall each paged
// Donations: 65-90 of a night's ~200 Monday calls were repeats, growing with the boards.
//
// sharedReadPlan names, per board, the union of the columns those duties read; sharedBoardReads
// wraps the run's Monday client so the first duty to page a planned board reads every planned
// column in one pass and later duties get the same items back. Duties are unchanged: each still
// pages with its own column list and sees its own columns (plus the others', which it ignores).
//
// The snapshot is the night's, the way each duty's own read was: a write this run makes is not
// read back. None of the sharing duties reads a column another one writes, except classify's
// blank Fiscal Year Ending fill, which credits derives from the Date the same way.
import { donationCreditColumnIds, donationCreditFrom, type ItemColumns } from '../monday/client';
import type { DonationRollupsConfig } from '../types';
import type { CustodianMondayClient } from './custodian';
import { classifyReadColumns } from './classify';
import { membershipTermStartColumns } from './membership';
import { recurringFlagColumns } from './recurring';
import { donorReadColumns } from './rollcall';

export type ReadPlan = Map<number, Set<string>>;

export function sharedReadPlan(config: DonationRollupsConfig): ReadPlan {
  const plan: ReadPlan = new Map();
  const add = (boardId: number | string, columnIds: string[]) => {
    const id = Number(boardId);
    const cols = plan.get(id) ?? new Set<string>();
    for (const c of columnIds) cols.add(c);
    plan.set(id, cols);
  };
  for (const b of membershipTermStartColumns(config)) add(b.boardId, [b.currentTermStart]);
  for (const b of recurringFlagColumns(config)) add(b.boardId, [b.columnId]);
  for (const board of config.donationRollups.donationBoards) {
    const cols = classifyReadColumns(board);
    if (cols !== null) add(board.boardId, cols);
  }
  const rollCall = config.donationRollups.rollCall;
  if (rollCall !== null) {
    for (const r of donorReadColumns(rollCall)) add(r.boardId, r.columnIds);
    add(rollCall.donations.boardId, donationCreditColumnIds(rollCall.donations));
  }
  return plan;
}

export function sharedBoardReads(client: CustodianMondayClient, plan: ReadPlan): CustodianMondayClient {
  // A failed read is remembered as null: every caller then falls back to its own read, so a
  // board Monday doesn't return reads as empty or throws exactly as it did per duty.
  const loads = new Map<number, Promise<ItemColumns[] | null>>();

  const load = (boardId: number, columns: Set<string>): Promise<ItemColumns[] | null> => {
    let pending = loads.get(boardId);
    if (pending === undefined) {
      pending = (async () => {
        const items: ItemColumns[] = [];
        let cursor: string | null = null;
        do {
          const page: { items: ItemColumns[]; cursor: string | null } =
            await client.pageItemsColumnsText(boardId, [...columns], cursor, { requireBoard: true });
          items.push(...page.items);
          cursor = page.cursor;
        } while (cursor !== null);
        return items;
      })().catch((err: unknown) => {
        console.warn(`donation-rollups custodian: shared read of board ${boardId} failed, each duty reads it itself: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
      loads.set(boardId, pending);
    }
    return pending;
  };

  // The whole board for a first-page request the plan covers; null to read it the duty's way.
  const shared = async (boardId: number, columnIds: string[], cursor: string | null): Promise<ItemColumns[] | null> => {
    const columns = plan.get(boardId);
    if (cursor !== null || columns === undefined || !columnIds.every((c) => columns.has(c))) return null;
    return load(boardId, columns);
  };

  const pageItemsColumnsText: CustodianMondayClient['pageItemsColumnsText'] = async (boardId, columnIds, cursor, opts) => {
    const items = await shared(boardId, columnIds, cursor);
    return items === null ? client.pageItemsColumnsText(boardId, columnIds, cursor, opts) : { items, cursor: null };
  };
  const pageDonationCredits: CustodianMondayClient['pageDonationCredits'] = async (cfg, cursor, fiscalYearStartMonth) => {
    const items = await shared(cfg.boardId, donationCreditColumnIds(cfg), cursor);
    return items === null ? client.pageDonationCredits(cfg, cursor, fiscalYearStartMonth)
      : { items: items.map((item) => donationCreditFrom(item, cfg, fiscalYearStartMonth)), cursor: null };
  };
  // Everything else goes to the client untouched (bound, so a recording proxy or a class
  // instance still sees itself as `this`).
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'pageItemsColumnsText') return pageItemsColumnsText;
      if (prop === 'pageDonationCredits') return pageDonationCredits;
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
