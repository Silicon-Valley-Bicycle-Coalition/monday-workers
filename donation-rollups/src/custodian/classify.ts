import { classifyGift, type GiftClassification } from '../rollups/classify';
import { parseAmountCents } from '../money';
import type { DonationRollupsConfig, ClassificationColumns } from '../types';
import type { DutyReport } from './custodian';

// Nightly: keep Funding Stream / Gift Size / Fiscal Quarter / Gift Fiscal Year current on
// every active gift (spec 2026-09-29 §10.1). Reads are cheap (500 items a page); writes are
// diffed and capped per run, and the webhook ignores these columns (webhook/route.ts), so a
// full backfill is a handful of runs rather than a recompute flood. Archived gifts aren't
// returned by items_page and aren't visible to dashboards either — nothing to classify.

export interface ClassifyClient {
  pageItemsColumnsText(boardId: number, columnIds: string[], cursor: string | null):
    Promise<{ items: { id: string; text: Map<string, string | null> }[]; cursor: string | null }>;
  changeColumnValues(boardId: number, itemId: string, values: Record<string, unknown>,
    opts?: { createLabelsIfMissing?: boolean }): Promise<void>;
}

export const CLASSIFY_WRITES_PER_RUN = 300;

const KEYS = ['fundingStream', 'giftSize', 'fiscalQuarter', 'giftFiscalYear'] as const;

function diff(want: GiftClassification, cols: ClassificationColumns, have: Map<string, string | null>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of KEYS) {
    const current = have.get(cols[key]) ?? '';
    if (current !== want[key]) out[cols[key]] = want[key] === '' ? '' : { label: want[key] };
  }
  return out;
}

export async function runClassify(client: ClassifyClient, config: DonationRollupsConfig): Promise<DutyReport> {
  let scanned = 0, changed = 0, written = 0;
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
        const values = diff(want, cl, item.text);
        if (Object.keys(values).length === 0) continue;
        changed++;
        if (written < CLASSIFY_WRITES_PER_RUN) {
          await client.changeColumnValues(board.boardId, item.id, values, { createLabelsIfMissing: true });
          written++;
        }
      }
      cursor = page.cursor;
    } while (cursor !== null);
  }
  const remaining = changed - written;
  return {
    ok: true,
    summary: `classified ${written} of ${changed} changed gifts (${scanned} scanned)` +
      (remaining > 0 ? ' — more remain, run classify again to continue' : ''),
    detail: { scanned, changed, written, remaining },
  };
}
