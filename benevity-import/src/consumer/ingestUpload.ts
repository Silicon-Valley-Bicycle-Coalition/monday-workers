import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementRow, DisbursementStore } from '../db/disbursements';
import type { NewRow, RowStatus, RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';
import { parseBenevityReport, type ParsedBlock } from '../parse/report';
import { blockWorklistKey, ensureWorklistItem } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';
import { sendInBatches, type BatchSender } from '../util/sendBatch';
import type { BenevityQueueMessage } from './processBatch';

// A real monthly report is tens of KB. Anything this large is not one, and parsing it could blow
// the Worker's CPU limit (wrangler.jsonc `limits.cpu_ms`) on every retry, so it is refused
// outright: marked 'error' and acked, like a file that fails to parse.
export const MAX_REPORT_LENGTH = 2 * 1024 * 1024;

// Thrown by readReportText (fetchCsv) once a response passes MAX_REPORT_LENGTH bytes.
export class ReportTooLargeError extends Error {}

/**
 * The body of a report response as text, never holding more than MAX_REPORT_LENGTH bytes of it.
 * Content-Length is only a fast path: a response without one (or a chunked one) is counted as it
 * streams, and cancelled the moment it passes the cap, before anything is decoded.
 */
export async function readReportText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('Content-Length'));
  if (declared > MAX_REPORT_LENGTH) {
    await response.body?.cancel();
    throw new ReportTooLargeError(`Content-Length ${declared}`);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REPORT_LENGTH) {
      await reader.cancel();
      throw new ReportTooLargeError(`over ${MAX_REPORT_LENGTH} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export interface IngestDeps {
  mondayClient: MondayClient;
  uploadStore: UploadStore;
  disbursementStore: DisbursementStore;
  rowStore: RowStore;
  config: BenevityImportConfig;
  queue: BatchSender<BenevityQueueMessage>;
  // Plain GET of the asset's time-limited public_url — separate from mondayClient's GraphQL
  // calls so tests can stub it without a fetch mock.
  fetchCsv: (url: string) => Promise<string>;
  now: () => string;
}

/**
 * Ingests one uploaded report, from a queue message the upload webhook sent (#74): fetch, parse,
 * record each block and its rows in D1, enqueue the rows to write. A throw leaves the message to
 * the queue's backoff; a file that can't be parsed (or is far too large to be a report) is marked
 * 'error' and returns, since a retry would only fail the same way.
 */
export async function ingestUpload(assetId: string, deps: IngestDeps): Promise<void> {
  const existing = await deps.uploadStore.getUploadByAssetId(assetId);
  if (existing !== null && existing.status === 'parsed') {
    // Redelivery of an already-FULLY-ingested asset — a fast no-op. Per-row dedup on
    // Transaction ID in D1 `rows` is the real safety net even if this check is ever bypassed.
    // Deliberately NOT short-circuiting on mere existence: an upload stuck at 'parsing' (a
    // prior attempt died partway through the block loop below) or 'error' (a prior parse
    // failure) must still be retried, or a transient failure on block 2 of a 3-block file would
    // silently and permanently drop blocks 2-3. Reusing `existing.id` here (never calling
    // createUpload twice) avoids violating uploads.monday_asset_id's UNIQUE constraint.
    return;
  }

  const asset = await deps.mondayClient.fetchAsset(assetId);
  const upload = existing ?? (await deps.uploadStore.createUpload(assetId, deps.now()));

  let csvText: string;
  try {
    csvText = await deps.fetchCsv(asset.publicUrl);
    if (csvText.length > MAX_REPORT_LENGTH) throw new ReportTooLargeError(`${csvText.length} characters`);
  } catch (err) {
    if (!(err instanceof ReportTooLargeError)) throw err; // a failed fetch is worth a retry
    await deps.uploadStore.markError(upload.id);
    console.error(`benevity consumer: asset "${assetId}" refused: larger than ${MAX_REPORT_LENGTH} characters (${err.message})`);
    return;
  }

  let blocks: ParsedBlock[];
  try {
    blocks = parseBenevityReport(csvText);
  } catch (err) {
    await deps.uploadStore.markError(upload.id);
    console.error(`benevity consumer: asset "${assetId}" failed to parse: ${errorMessage(err)}`);
    return;
  }

  // Resume, don't restart. A retry re-fetches and re-parses the SAME asset (a pure function of
  // its bytes), so block order and content are stable across attempts, and each block finds
  // its own disbursements row from a prior attempt by (upload, position) — or, for the same
  // report re-uploaded as a new asset, by its Benevity Disbursement ID (#34). Either way the
  // row and its worklist item are reused, never created twice, while the row upsert always
  // re-runs (it is safe to repeat — `ON CONFLICT (transaction_id) DO NOTHING`), so a block
  // that failed mid-processing resumes exactly where it left off.
  try {
    for (const [i, block] of blocks.entries()) {
      await ingestBlock(block, i, upload.id, assetId, deps);
    }
  } catch (err) {
    // Mark it visibly failed (not stuck silently at 'parsing') and rethrow so the consumer
    // retries the message — this same asset id then resumes above instead of no-op'ing past it.
    await deps.uploadStore.markError(upload.id);
    throw err;
  }

  await deps.uploadStore.markParsed(upload.id, blocks.length);
}

async function ingestBlock(
  block: ParsedBlock,
  blockIndex: number,
  uploadId: number,
  assetId: string,
  deps: IngestDeps
): Promise<void> {
  // The cutoff gates whole disbursements, on their Period Ending (#40) — never on a row's Donation
  // Date. Benevity pays out weeks after the gift, so the first disbursement after the data freeze
  // is mostly rows dated before it, and none of them were ever keyed into Salesforce (staff key
  // from the disbursement report). The per-row Transaction ID lookup stays the duplicate guard.
  // A block whose header didn't parse has no trustworthy Period Ending (or rows): it is held for
  // review below, whatever the cutoff.
  const cutoff = deps.config.benevityImport.minDisbursementDate;
  const beforeCutoff = block.headerError === null && block.periodEnding !== '' && block.periodEnding < cutoff;
  const needsReview = !beforeCutoff && (block.headerError !== null || block.sumMismatch);
  const reviewReason = needsReview
    ? (block.headerError ?? 'row totals do not match the reported gross total')
    : null;

  const { disbursement } = await deps.disbursementStore.findOrCreate({
    uploadId,
    blockIndex,
    disbursementId: block.disbursementId,
    periodEnding: block.periodEnding,
    currency: block.currency,
    rowCount: block.rows.length,
    reportedGrossTotal: block.reportedGrossTotal,
    reportedNetTotal: block.reportedNetTotal,
    needsReview,
    reviewReason,
  });

  if (beforeCutoff) {
    // Never silent: one notice on the worklist says what was left out and why, and a staff Retry
    // on it imports the disbursement anyway (requeueDisbursementRows releases 'skipped' rows).
    const retryConfigured = Boolean(deps.config.benevityImport.uploadsBoard.retry);
    await ensureBlockWorklistItem(block, blockIndex, assetId, disbursement, skippedReason(block, cutoff, retryConfigured), deps);
    // Recorded, so the rows are known (a re-upload can't import them by accident) and a Retry has
    // something to release. `ON CONFLICT DO NOTHING`: a row already further along keeps its status.
    await upsertBlockRows(block, disbursement.id, 'skipped', deps);
    console.log(
      `benevity consumer: skipped disbursement "${block.disbursementId}" (Period Ending ${block.periodEnding}, before cutoff ${cutoff}): ${block.rows.length} row(s)`
    );
    return;
  }

  if (needsReview) {
    await ensureBlockWorklistItem(block, blockIndex, assetId, disbursement, reviewReason ?? 'block needs review', deps);
    // Every row is (re-)recorded so nothing is silently lost, but none are enqueued — spec: "a
    // mismatch marks the whole block needs-review rather than writing partial data from a
    // block the parser may have mis-split." Idempotent even on a retry of this exact block.
    await upsertBlockRows(block, disbursement.id, 'needs-review', deps);
    return;
  }

  // Every row still at 'ingested' afterwards is sent: a new one, or one an earlier attempt upserted
  // but never got onto the queue (it threw before or during the send) — nothing else would ever
  // retry that one. A row already 'written'/'needs-review'/'skipped' is a genuinely completed
  // outcome and is not re-sent. If the send fails the block throws, the upload is marked 'error',
  // the message is retried, and this same check re-sends whatever is still 'ingested'.
  const statuses = await upsertBlockRows(block, disbursement.id, 'ingested', deps);
  const toSend: BenevityQueueMessage[] = block.rows
    .filter((row) => statuses.get(row.transactionId) === 'ingested')
    .map((row) => ({ transactionId: row.transactionId }));
  await sendInBatches(deps.queue, toSend);
}

// One batched D1 call per block (rowStore.upsertRows), not one round trip per row.
function upsertBlockRows(block: ParsedBlock, disbursementId: number, status: RowStatus, deps: IngestDeps): Promise<Map<string, RowStatus>> {
  const ingestedAt = deps.now();
  const rows: NewRow[] = block.rows.map((row) => ({
    transactionId: row.transactionId,
    disbursementId,
    rawRow: JSON.stringify(row),
    status,
    ingestedAt,
  }));
  return deps.rowStore.upsertRows(rows);
}

// One worklist item per block, ever: nothing is posted once its id is recorded (a resumed attempt,
// or the same disbursement re-uploaded), and an item an earlier attempt created but died before
// recording is adopted rather than re-posted (#34).
async function ensureBlockWorklistItem(
  block: ParsedBlock,
  blockIndex: number,
  assetId: string,
  disbursement: DisbursementRow,
  reason: string,
  deps: IngestDeps
): Promise<void> {
  if (disbursement.worklistItemId !== null) return;
  const worklistItemId = await ensureWorklistItem(
    deps.mondayClient,
    deps.config,
    {
      key: blockWorklistKey(block.disbursementId, assetId, blockIndex),
      reason,
      name: `Disbursement ${block.disbursementId || '(unknown)'}`,
      email: '',
      company: block.charityName,
      amount: block.reportedGrossTotal,
      date: block.periodEnding || deps.now().slice(0, 10),
    },
    null
  );
  const recorded = await deps.disbursementStore.claimWorklistItemId(disbursement.id, worklistItemId);
  if (recorded !== worklistItemId) {
    // Another delivery (e.g. the same report uploaded twice at once) recorded its item first.
    // Keep that one; archive ours so the block has a single worklist item. Best-effort: a
    // leftover duplicate is untidy, not wrong, and must not fail the upload.
    console.warn(
      `benevity consumer: block "${block.disbursementId}" already has worklist item "${recorded}"; archiving duplicate "${worklistItemId}"`
    );
    try {
      await deps.mondayClient.archiveItem(worklistItemId);
    } catch (err) {
      console.error(`benevity consumer: could not archive duplicate worklist item "${worklistItemId}": ${errorMessage(err)}`);
    }
  }
}

// What a skipped disbursement's worklist notice says (#40): what was left out, by how much and
// over which donation dates, why, and what to do if the assumption behind the cutoff is wrong.
function skippedReason(block: ParsedBlock, cutoff: string, retryConfigured: boolean): string {
  const dates = block.rows.map((row) => row.donationDate).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const rows = block.rows.length === 1 ? '1 row' : `${block.rows.length} rows`;
  const range = first === undefined ? '' : first === last ? `, donation date ${first}` : `, donation dates ${first} to ${last}`;
  return (
    `Skipped, not imported: Period Ending ${block.periodEnding} is before the import cutoff ${cutoff}, so this ` +
    `disbursement is assumed to be in the migrated Salesforce history already. ` +
    `${rows}${range}, $${block.reportedGrossTotal.toFixed(2)} gross.` +
    (block.sumMismatch ? " Its row totals also don't match the reported gross total, so check the file first." : '') +
    (retryConfigured
      ? ' If it was never keyed into Salesforce, set Retry to import it; otherwise leave it as it is.'
      : ' If it was never keyed into Salesforce, it is missing from the CRM: enter it by hand from the report, or ask engineering to re-queue it.')
  );
}
