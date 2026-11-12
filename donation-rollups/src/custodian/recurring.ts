// The recurring duty (monday-migration docs/35 §3.1): keeps People's Has Active Recurring Gift
// checkbox in step with the Recurring Gifts board, so the Postal appeal list can leave out donors
// who already give monthly or quarterly. Recurring Gifts isn't a Donations board, so no webhook
// reaches this Worker when a subscription starts or lapses; a nightly full read is the source of
// truth instead. Reads are cheap; only cells that disagree are written, so a quiet night writes
// nothing. Writes are capped per run and the rest wait for the next night (remaining > 0 re-runs).
import type { CustodianDeps, DutyReport } from './custodian';
import type { DonationRollupsConfig } from '../types';

export const RECURRING_WRITES_PER_RUN = 500;

export interface RecurringDetail {
  activeDonors: number; checked: number; cleared: number; remaining: number;
}

// Monday's checkbox text is "v" when checked and empty otherwise.
export const isChecked = (text: string | null): boolean => text !== null && text !== '';

// The owner boards carrying a Has Active Recurring Gift column. Exported for the custodian's
// shared board read (boardReads.ts, issue #90).
export function recurringFlagColumns(config: DonationRollupsConfig): { boardId: string; columnId: string }[] {
  if (config.donationRollups.recurringGifts === null) return [];
  return Object.entries(config.donationRollups.ownerColumnsByBoard)
    .flatMap(([boardId, cols]) => (cols.hasActiveRecurringGift ? [{ boardId, columnId: cols.hasActiveRecurringGift }] : []));
}

export async function runRecurring(deps: CustodianDeps): Promise<DutyReport> {
  const cfg = deps.config.donationRollups.recurringGifts;
  if (cfg === null) return { ok: true, summary: 'recurring: not configured, skipped' };

  const active = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await deps.mondayClient.pageRecurringGifts(cfg, cursor);
    for (const item of page.items) {
      if (item.statusLabel === cfg.activeStatusLabel) for (const id of item.donorItemIds) active.add(id);
    }
    cursor = page.cursor;
  } while (cursor !== null);

  const writes: { boardId: number; itemId: string; columnId: string; check: boolean }[] = [];
  for (const { boardId, columnId } of recurringFlagColumns(deps.config)) {
    let page: string | null = null;
    do {
      const res = await deps.mondayClient.pageItemsColumnsText(Number(boardId), [columnId], page);
      for (const item of res.items) {
        const want = active.has(item.id);
        if (want !== isChecked(item.text.get(columnId) ?? null)) {
          writes.push({ boardId: Number(boardId), itemId: item.id, columnId, check: want });
        }
      }
      page = res.cursor;
    } while (page !== null);
  }

  const now: typeof writes = [];
  for (const w of writes.slice(0, RECURRING_WRITES_PER_RUN)) {
    if (deps.writeBudget?.take() === false) break;
    await deps.mondayClient.changeColumnValues(w.boardId, w.itemId, { [w.columnId]: w.check ? { checked: 'true' } : null });
    now.push(w);
  }
  const detail: RecurringDetail = {
    activeDonors: active.size, checked: now.filter((w) => w.check).length,
    cleared: now.filter((w) => !w.check).length, remaining: writes.length - now.length,
  };
  return { ok: true, detail,
    summary: `recurring: ${active.size} donors with an active recurring gift; checked ${detail.checked}, ` +
      `cleared ${detail.cleared}${detail.remaining > 0 ? `, ${detail.remaining} left for the next run` : ''}` };
}
