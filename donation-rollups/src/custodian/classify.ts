import { classifyGift, type GiftClassification } from '../rollups/classify';
import { parseAmountCents } from '../money';
import { MondayRateLimitError, statusLabel, type ItemColumns } from '../monday/client';
import type { DonationRollupsConfig, ClassificationColumns } from '../types';
import type { DutyReport } from './custodian';

// Nightly: keep Funding Stream / Gift Size / Fiscal Quarter / Gift Fiscal Year current on
// every active gift (spec 2026-09-29 §10.1). Reads are cheap (500 items a page); writes are
// diffed and capped per run, and the webhook ignores these columns (webhook/route.ts), so a
// full backfill is a handful of runs rather than a recompute flood. Archived gifts aren't
// returned by items_page and aren't visible to dashboards either — nothing to classify.

export interface ClassifyClient {
  pageItemsColumnsText(boardId: number, columnIds: string[], cursor: string | null):
    Promise<{ items: ItemColumns[]; cursor: string | null }>;
  changeColumnValues(boardId: number, itemId: string, values: Record<string, unknown>,
    opts?: { createLabelsIfMissing?: boolean }): Promise<void>;
}

export const CLASSIFY_WRITES_PER_RUN = 300;
const FAILED_IDS_IN_REPORT = 20;

const KEYS = ['fundingStream', 'giftSize', 'fiscalQuarter', 'giftFiscalYear'] as const;

// All four are status columns, so they're compared by stored value — a blank cell's text can be
// a real label (label id 5), which would skip a write the gift needs.
function diff(want: GiftClassification, cols: ClassificationColumns, have: ItemColumns): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    const current = statusLabel(have.text.get(cols[key]), have.values.get(cols[key])) ?? '';
    if (current !== want[key]) out[cols[key]] = want[key] === '' ? '' : { label: want[key] };
  }
  return out;
}

export async function runClassify(client: ClassifyClient, config: DonationRollupsConfig): Promise<DutyReport> {
  let scanned = 0, changed = 0, written = 0;
  const failed: string[] = [];
  for (const board of config.donationRollups.donationBoards) {
    const cl = board.columns.classification;
    if (!cl) continue;
    const readCols = [board.columns.amount, board.columns.date,
      ...(board.columns.giftType ? [board.columns.giftType] : []), ...KEYS.map((k) => cl[k])];
    let cursor: string | null = null;
    do {
      const page = await client.pageItemsColumnsText(board.boardId, readCols, cursor);
      for (const item of page.items) {
        scanned++;
        const amountText = item.text.get(board.columns.amount) ?? null;
        const want = classifyGift({
          amountCents: amountText === null ? null : parseAmountCents(amountText),
          dateISO: item.text.get(board.columns.date) ?? null,
          giftType: board.columns.giftType ? item.text.get(board.columns.giftType) ?? null : null,
        }, config.fiscalYear.startMonth);
        const values = diff(want, cl, item);
        if (Object.keys(values).length === 0) continue;
        changed++;
        if (written + failed.length < CLASSIFY_WRITES_PER_RUN) {
          // One bad item (deleted mid-run, a locked column…) must not stop the rest; a rate
          // limit will fail every remaining write too, so that one still ends the run.
          try {
            await client.changeColumnValues(board.boardId, item.id, values, { createLabelsIfMissing: true });
            written++;
          } catch (err) {
            if (err instanceof MondayRateLimitError) throw err;
            failed.push(item.id);
          }
        }
      }
      cursor = page.cursor;
    } while (cursor !== null);
  }
  const remaining = changed - written - failed.length;
  return {
    ok: failed.length === 0,
    summary: `classified ${written} of ${changed} changed gifts (${scanned} scanned)` +
      (failed.length > 0 ? `; ${failed.length} item write(s) failed` : '') +
      (remaining > 0 ? ' — more remain, run classify again to continue' : ''),
    detail: { scanned, changed, written, remaining, failed: failed.length, failedItemIds: failed.slice(0, FAILED_IDS_IN_REPORT) },
  };
}
