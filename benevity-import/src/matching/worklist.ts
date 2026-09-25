import type { MondayClient } from '../monday/client';
import type { BenevityImportConfig } from '../types';

export interface WorklistItemInput {
  // Stable identity of what the item stands for: the row's Transaction ID, or a block key (see
  // blockWorklistKey). Written to uploadsBoard.worklistKeyColumn when that is configured.
  key: string;
  reason: string;
  name: string;
  email: string;
  company: string;
  amount: number;
  date: string;
}

/**
 * Returns the id of the one worklist item for `input.key`, creating it only if none exists
 * (#34). Monday's createItem has no dedup of its own, so a retry that re-ran it after the
 * item was posted but before D1 recorded its id would post a duplicate. Lookup order:
 *
 * 1. `recordedItemId` — the id D1 already holds for this row/block. Reused as-is.
 * 2. The board, by key, in uploadsBoard.worklistKeyColumn — the pre-create lookup that catches
 *    an item created by an attempt whose D1 write was lost (same shape as the Donations
 *    Transaction ID lookup). Skipped while that column isn't configured.
 * 3. Otherwise create, stamped with the key.
 *
 * A reused item gets the latest reason written back, so a row that fails again after a staff
 * Retry says why on the same item.
 */
export async function ensureWorklistItem(
  mondayClient: MondayClient,
  config: BenevityImportConfig,
  input: WorklistItemInput,
  recordedItemId: string | null
): Promise<string> {
  const boardId = config.monday.boards.benevityUploads;
  if (boardId === null) {
    throw new Error('config: monday.boards.benevityUploads is not configured');
  }
  const { worklistColumns, worklistGroupId, worklistKeyColumn } = config.benevityImport.uploadsBoard;

  let existingId = recordedItemId;
  if (existingId === null && worklistKeyColumn) {
    const found = await mondayClient.findItemsByColumnValue(boardId, worklistKeyColumn, input.key);
    existingId = found[0]?.id ?? null;
  }
  if (existingId !== null) {
    await mondayClient.changeColumnValues(boardId, existingId, { [worklistColumns.reason]: input.reason });
    return existingId;
  }

  const created = await mondayClient.createItem(
    boardId,
    input.name || input.company || 'Benevity row needs review',
    {
      [worklistColumns.reason]: input.reason,
      [worklistColumns.email]: input.email,
      [worklistColumns.company]: input.company,
      [worklistColumns.amount]: input.amount,
      [worklistColumns.date]: { date: input.date },
      ...(worklistKeyColumn ? { [worklistKeyColumn]: input.key } : {}),
    },
    worklistGroupId
  );
  return created.id;
}

// A block's worklist key: its Benevity Disbursement ID when the header parsed, else its position
// in the upload that produced it (an unparseable header has no id to go by).
export function blockWorklistKey(disbursementId: string, assetId: string, blockIndex: number): string {
  return disbursementId !== '' ? `disbursement ${disbursementId}` : `upload ${assetId} block ${blockIndex}`;
}
