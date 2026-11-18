import { acknowledgmentTier, classifyGift, fiscalYearEnding, type GiftClassification } from '../rollups/classify';
import { parseAmountCents } from '../money';
import { MondayRateLimitError, statusLabel, type ItemColumns } from '../monday/client';
import type { DonationRollupsConfig, ClassificationColumns, DonationBoardConfig } from '../types';
import type { DutyReport } from './custodian';
import type { WriteBudget } from './writeBudget';

// Nightly: keep Funding Stream / Gift Size / Fiscal Quarter / Gift Fiscal Year current on
// every active gift (spec 2026-09-29 §10.1), and Acknowledgment Tier where it's configured. Also
// fills a BLANK Fiscal Year Ending (hand-entered gifts and the manual entry form have no writer
// that stamps it; Funraise and the import do). A stamped value is never overwritten. Reads are cheap (500 items a page); writes are
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

// All are status columns, so they're compared by stored value — a blank cell's text can be
// a real label (label id 5), which would skip a write the gift needs.
function diff(want: GiftClassification, tier: string | null, company: string | null, cols: ClassificationColumns, have: ItemColumns): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const current = (col: string): string => statusLabel(have.text.get(col), have.values.get(col)) ?? '';
  for (const key of KEYS) {
    if (current(cols[key]) !== want[key]) out[cols[key]] = want[key] === '' ? '' : { label: want[key] };
  }
  // Tier is never cleared: a gift without an amount keeps whatever it has.
  if (cols.acknowledgmentTier && tier !== null && current(cols.acknowledgmentTier) !== tier) {
    out[cols.acknowledgmentTier] = { label: tier };
  }
  // Matching Company mirrors the Matched By link's name; no link clears it. null = not configured.
  if (cols.matchingCompany && company !== null && current(cols.matchingCompany) !== company) {
    out[cols.matchingCompany] = company === '' ? '' : { label: company };
  }
  return out;
}

// The columns classify reads from a Donations board, or null when the board isn't classified.
// Exported for the custodian's shared board read (boardReads.ts, issue GL#90).
export function classifyReadColumns(board: DonationBoardConfig): string[] | null {
  const cl = board.columns.classification;
  if (!cl) return null;
  const matchedByCol = board.columns.matchedBy;
  const matchingOn = Boolean(cl.matchingCompany && matchedByCol);
  return [board.columns.amount, board.columns.date,
    ...(board.columns.giftType ? [board.columns.giftType] : []), ...KEYS.map((k) => cl[k]),
    ...(cl.acknowledgmentTier ? [cl.acknowledgmentTier] : []),
    ...(matchingOn ? [cl.matchingCompany!, matchedByCol!] : []),
    ...(board.columns.fiscalYear ? [board.columns.fiscalYear] : [])];
}

export async function runClassify(client: ClassifyClient, config: DonationRollupsConfig, budget?: WriteBudget): Promise<DutyReport> {
  let scanned = 0, changed = 0, written = 0;
  const failed: string[] = [];
  for (const board of config.donationRollups.donationBoards) {
    const cl = board.columns.classification;
    const readCols = classifyReadColumns(board);
    if (!cl || readCols === null) continue;
    const matchedByCol = board.columns.matchedBy;
    const matchingOn = Boolean(cl.matchingCompany && matchedByCol);
    let cursor: string | null = null;
    do {
      const page = await client.pageItemsColumnsText(board.boardId, readCols, cursor);
      for (const item of page.items) {
        scanned++;
        const amountText = item.text.get(board.columns.amount) ?? null;
        const amountCents = amountText === null ? null : parseAmountCents(amountText);
        const want = classifyGift({
          amountCents,
          dateISO: item.text.get(board.columns.date) ?? null,
          giftType: board.columns.giftType ? item.text.get(board.columns.giftType) ?? null : null,
        }, config.fiscalYear.startMonth);
        const company = matchingOn ? (item.text.get(matchedByCol!) ?? '').trim() : null;
        const values = diff(want, acknowledgmentTier(amountCents), company, cl, item);
        // A text column: blank means empty or whitespace. Compared as text, never by stored value.
        const fyCol = board.columns.fiscalYear;
        if (fyCol && (item.text.get(fyCol) ?? '').trim() === '') {
          const fy = fiscalYearEnding(item.text.get(board.columns.date) ?? null, config.fiscalYear.startMonth);
          if (fy !== null) values[fyCol] = fy;
        }
        if (Object.keys(values).length === 0) continue;
        changed++;
        if (written + failed.length < CLASSIFY_WRITES_PER_RUN && budget?.take() !== false) {
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
