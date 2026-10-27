import { Hono, type Context } from 'hono';
import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementRow, DisbursementStore } from '../db/disbursements';
import type { RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';
import { parseBenevityReport, type ParsedBlock } from '../parse/report';
import { isChallenge, validateRetryEvent, validateUploadEvent } from './validate';
import { annotateWorklistItem, blockWorklistKey, ensureWorklistItem, setWorklistLabel } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';
import type { BenevityQueueMessage } from '../consumer/processBatch';
import { sendInBatches, type BatchSender } from '../util/sendBatch';
import { logSkip } from '../flags';
import { dryRunAppDeps, type BatchSkipContext } from '../writeSwitch';

// Queue producer surface the route needs. Rows are sent with sendBatch (chunked to Queues' 100
// messages / 256 KB per call, see util/sendBatch.ts) rather than one send() per row, so a large
// bundled report doesn't spend one subrequest per row inside the webhook request.
export type QueueLike = BatchSender<BenevityQueueMessage>;

// Shared-secret check for the Monday webhook URLs. Fails closed when the secret is unset or
// empty (an empty `?secret=` must never match), and compares SHA-256 digests of both sides with a
// non-short-circuiting loop so the response time doesn't leak how much of a guess was right.
// Same shape as funraise-sync's secretsMatch (no shared package between Workers).
export async function secretsMatch(presented: string | undefined, expected: string | undefined): Promise<boolean> {
  if (presented === undefined || expected === undefined || expected === '') return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(presented)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export interface AppDeps {
  mondayClient: MondayClient;
  uploadStore: UploadStore;
  disbursementStore: DisbursementStore;
  rowStore: RowStore;
  config: BenevityImportConfig;
  queue: QueueLike;
  // The write switch's mode and log level (flags.ts), read once per accepted request. The
  // challenge echo is answered before it; `hold`/`unknown` then answer 503 before any store or
  // Monday call, and `off` runs the upload route against recording deps (writeSwitch.ts).
  gate: () => Promise<BatchSkipContext>;
  // Shared secret required as `?secret=...` on the registered Monday webhook URL
  // (`wrangler secret put BENEVITY_WEBHOOK_SECRET`). Fails closed when unset.
  webhookSecret: string | undefined;
  // Plain GET of the asset's time-limited public_url — separate from mondayClient's GraphQL
  // calls so tests can stub it without a fetch mock.
  fetchCsv: (url: string) => Promise<string>;
  now: () => string;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/webhooks/monday/benevity-upload', async (c) => {
    const body = await readMondayWebhook(c, deps);
    if (body instanceof Response) return body;

    const gate = await deps.gate();
    if (gate.mode !== 'on' && gate.mode !== 'off') return writesHeld(c);

    let event;
    try {
      event = validateUploadEvent(body);
    } catch (err) {
      console.error(`benevity webhook: rejected delivery: ${errorMessage(err)}`);
      return c.json({ ok: false, error: errorMessage(err) }, 200);
    }

    if (event.columnId !== deps.config.benevityImport.uploadsBoard.fileColumn) {
      // The webhook subscription should already be scoped to this one column at setup time —
      // this is a defensive double-check, not the primary filter (see the note on
      // ValidatedUploadEvent.columnId in webhook/validate.ts).
      return c.json({ ok: true, ignored: true }, 200);
    }

    const live = gate.mode === 'on' ? deps : dryRunAppDeps(deps, { ...gate, deliveryId: `item:${event.itemId}` });
    for (const assetId of event.assetIds) {
      try {
        await ingestAsset(assetId, live);
      } catch (err) {
        console.error(`benevity webhook: failed to ingest asset "${assetId}": ${errorMessage(err)}`);
        return c.json({ ok: false }, 500);
      }
    }

    return c.json({ ok: true }, 200);
  });

  // Replay (#34): staff set a worklist item's Retry status column to the configured `retry`
  // label once they've fixed what it reported (created the Organization, attached the Person,
  // checked the block's totals, ...). A Monday webhook on that column lands here. The Worker
  // moves the row — or, for a block-level item, every row of that disbursement — from
  // 'needs-review' back to 'ingested', enqueues it, and sets the item to `queued`; the consumer
  // later sets `done` or, if it still can't resolve the row, `needsReview` with the new reason.
  // Idempotent: a repeated Retry re-sends only rows still pending, and the consumer ignores a
  // message for a row that has since been written or re-reviewed.
  app.post('/webhooks/monday/benevity-retry', async (c) => {
    const body = await readMondayWebhook(c, deps);
    if (body instanceof Response) return body;

    const gate = await deps.gate();
    if (gate.mode !== 'on' && gate.mode !== 'off') return writesHeld(c);

    const retry = deps.config.benevityImport.uploadsBoard.retry;
    if (!retry) {
      return c.json({ ok: true, ignored: true }, 200);
    }

    let event;
    try {
      event = validateRetryEvent(body);
    } catch (err) {
      console.error(`benevity retry webhook: rejected delivery: ${errorMessage(err)}`);
      return c.json({ ok: false, error: errorMessage(err) }, 200);
    }
    // Only a change *to* Retry on the Retry column. Every other label — including the Worker's
    // own Queued/Done/Needs review writes, which fire this same webhook — is ignored.
    if (event.columnId !== retry.column || event.label !== retry.labels.retry) {
      return c.json({ ok: true, ignored: true }, 200);
    }

    if (gate.mode === 'off') {
      // A replay is all writes (worklist labels, requeues, queue sends), so there is nothing to
      // dry-run: say so and leave the item at Retry for when writes are on.
      logSkip({ ...gate, deliveryId: `item:${event.itemId}` }, 'benevity-retry', 'replayWorklistItem', { itemId: event.itemId });
      return c.json({ ok: true, skipped: true }, 200);
    }

    let result: ReplayResult;
    try {
      result = await replayWorklistItem(event.itemId, deps);
    } catch (err) {
      console.error(`benevity retry webhook: failed to replay worklist item "${event.itemId}": ${errorMessage(err)}`);
      return c.json({ ok: false }, 500); // Monday redelivers; the replay is safe to repeat
    }
    console.log(`benevity retry webhook: worklist item "${event.itemId}": ${result.outcome}, ${result.enqueued} row(s) enqueued`);
    return c.json({ ok: true, ...result }, 200);
  });

  return app;
}

async function ingestAsset(assetId: string, deps: AppDeps): Promise<void> {
  const existing = await deps.uploadStore.getUploadByAssetId(assetId);
  if (existing !== null && existing.status === 'parsed') {
    // Redelivery of an already-FULLY-ingested asset — a fast no-op. Per-row dedup on
    // Transaction ID in D1 `rows` is the real safety net even if this check is ever bypassed.
    // Deliberately NOT short-circuiting on mere existence: an upload stuck at 'parsing' (a
    // prior attempt died partway through the block loop below) or 'error' (a prior parse
    // failure) must still be retried on redelivery, or a transient failure on block 2 of a
    // 3-block file would silently and permanently drop blocks 2-3 forever, while still
    // answering Monday's redelivery with 200. Reusing `existing.id` here (never calling
    // createUpload twice) avoids violating uploads.monday_asset_id's UNIQUE constraint.
    return;
  }

  const asset = await deps.mondayClient.fetchAsset(assetId);
  const csvText = await deps.fetchCsv(asset.publicUrl);
  const upload = existing ?? (await deps.uploadStore.createUpload(assetId, deps.now()));

  let blocks: ParsedBlock[];
  try {
    blocks = parseBenevityReport(csvText);
  } catch (err) {
    await deps.uploadStore.markError(upload.id);
    console.error(`benevity webhook: asset "${assetId}" failed to parse: ${errorMessage(err)}`);
    return;
  }

  // Resume, don't restart. A retry re-fetches and re-parses the SAME asset (a pure function of
  // its bytes), so block order and content are stable across attempts, and each block finds
  // its own disbursements row from a prior attempt by (upload, position) — or, for the same
  // report re-uploaded as a new asset, by its Benevity Disbursement ID (#34). Either way the
  // row and its worklist item are reused, never created twice, while the row-upsert loop always
  // re-runs (row upserts are safe to repeat — `ON CONFLICT (transaction_id) DO NOTHING`), so a
  // block that failed mid-processing resumes exactly where it left off.
  try {
    for (const [i, block] of blocks.entries()) {
      await ingestBlock(block, i, upload.id, assetId, deps);
    }
  } catch (err) {
    // Mark it visibly failed (not stuck silently at 'parsing') and rethrow so the webhook
    // handler's outer catch returns 500 — Monday redelivers, and this same asset id resumes
    // processing above instead of no-op'ing past it.
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
  deps: AppDeps
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
    for (const row of block.rows) {
      await deps.rowStore.upsertRow({
        transactionId: row.transactionId,
        disbursementId: disbursement.id,
        rawRow: JSON.stringify(row),
        status: 'skipped',
        ingestedAt: deps.now(),
      });
    }
    console.log(
      `benevity webhook: skipped disbursement "${block.disbursementId}" (Period Ending ${block.periodEnding}, before cutoff ${cutoff}): ${block.rows.length} row(s)`
    );
    return;
  }

  if (needsReview) {
    await ensureBlockWorklistItem(block, blockIndex, assetId, disbursement, reviewReason ?? 'block needs review', deps);
    // Every row is (re-)recorded so nothing is silently lost, but none are enqueued — spec: "a
    // mismatch marks the whole block needs-review rather than writing partial data from a
    // block the parser may have mis-split." Idempotent even on a retry of this exact block.
    for (const row of block.rows) {
      await deps.rowStore.upsertRow({
        transactionId: row.transactionId,
        disbursementId: disbursement.id,
        rawRow: JSON.stringify(row),
        status: 'needs-review',
        ingestedAt: deps.now(),
      });
    }
    return;
  }

  // Collected and sent once per block, after every row is upserted. If the send fails the
  // block throws, the upload is marked 'error', Monday redelivers, and the 'duplicate' branch
  // below re-sends every row still at 'ingested' — the same recovery a failed single send had.
  const toSend: BenevityQueueMessage[] = [];
  for (const row of block.rows) {
    const result = await deps.rowStore.upsertRow({
      transactionId: row.transactionId,
      disbursementId: disbursement.id,
      rawRow: JSON.stringify(row),
      status: 'ingested',
      ingestedAt: deps.now(),
    });
    if (result === 'inserted') {
      toSend.push({ transactionId: row.transactionId });
    } else {
      // 'duplicate': this row already exists from an earlier attempt. If it's still sitting at
      // 'ingested', that attempt's own send may never have gone through (it upserted the row,
      // then threw before or during send) — nothing else will ever retry it, so send it now. A row
      // already 'written'/'needs-review'/'skipped' is a genuinely completed outcome and must NOT
      // be re-sent.
      const existingRow = await deps.rowStore.getRow(row.transactionId);
      if (existingRow?.status === 'ingested') {
        toSend.push({ transactionId: row.transactionId });
      }
    }
  }
  await sendInBatches(deps.queue, toSend);
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
  deps: AppDeps
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
      `benevity webhook: block "${block.disbursementId}" already has worklist item "${recorded}"; archiving duplicate "${worklistItemId}"`
    );
    try {
      await deps.mondayClient.archiveItem(worklistItemId);
    } catch (err) {
      console.error(`benevity webhook: could not archive duplicate worklist item "${worklistItemId}": ${errorMessage(err)}`);
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

// Under `hold` (or a KV read failure) the webhook is not accepted: 503 makes Monday redeliver
// once writes are back on, rather than the delivery being absorbed with nothing done.
function writesHeld(c: Context): Response {
  return c.json({ ok: false, error: 'writes are on hold' }, 503);
}

// Shared front half of every Monday webhook route: shared-secret check (fails closed when
// unset), JSON parse, and the subscribe handshake. Returns the parsed body, or the Response to
// send instead.
async function readMondayWebhook(c: Context, deps: AppDeps): Promise<unknown> {
  if (!(await secretsMatch(c.req.query('secret'), deps.webhookSecret))) {
    return c.json({ ok: false }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'invalid JSON body' }, 200);
  }
  if (isChallenge(body)) {
    return c.json(body, 200);
  }
  return body;
}

interface ReplayResult {
  outcome: 'row' | 'block' | 'row already written' | 'row skipped' | 'row purged' | 'nothing to retry' | 'unknown item';
  enqueued: number;
  purged?: number;
}

const UNKNOWN_ITEM_REASON =
  "Can't retry this item: the Worker has no record linking it to a Benevity row — it was created before " +
  'Retry support was added (#34), or by hand. Enter the gift by hand on the Donations board from the ' +
  "report (re-uploading won't re-import a row the Worker has already seen), or ask engineering to re-queue it.";

function purgedReason(count: number, retentionDays: number, ofBlock: boolean): string {
  const which = ofBlock ? `${count} row(s) in this block` : 'this row';
  return (
    `Can't retry ${which}: the Worker deletes a row's Benevity details ${retentionDays} days after import ` +
    `(unresolvedRowRetentionDays), so there is nothing left to re-run. Enter the gift by hand on the ` +
    `Donations board from the original report — re-uploading the report won't re-import a row the Worker has already seen.`
  );
}

async function replayWorklistItem(itemId: string, deps: AppDeps): Promise<ReplayResult> {
  let outcome: ReplayResult['outcome'];
  let transactionIds: string[];
  const retentionDays = deps.config.benevityImport.unresolvedRowRetentionDays;

  const row = await deps.rowStore.getRowByWorklistItemId(itemId);
  if (row !== null) {
    if (row.status === 'written' || row.status === 'skipped') {
      // Nothing to redo. Say so on the board rather than leaving the item at Retry.
      await setWorklistLabel(deps.mondayClient, deps.config, itemId, 'done');
      return { outcome: row.status === 'written' ? 'row already written' : 'row skipped', enqueued: 0 };
    }
    const { requeued, purged } = await deps.rowStore.requeueRow(row.transactionId);
    if (purged > 0) {
      await annotateWorklistItem(deps.mondayClient, deps.config, itemId, purgedReason(1, retentionDays, false));
      return { outcome: 'row purged', enqueued: 0, purged };
    }
    outcome = 'row';
    transactionIds = requeued;
  } else {
    const disbursement = await deps.disbursementStore.getByWorklistItemId(itemId);
    if (disbursement === null) {
      // No D1 record links this item to a row or block: it was posted before worklist item ids
      // were recorded (migration 0003), or made by hand. Say so on the item rather than leaving
      // it sitting at Retry.
      await annotateWorklistItem(deps.mondayClient, deps.config, itemId, UNKNOWN_ITEM_REASON);
      return { outcome: 'unknown item', enqueued: 0 };
    }
    // Staff have checked the block (e.g. its totals mismatch was a Benevity rounding quirk), or
    // confirmed that a disbursement the cutoff skipped was never keyed into Salesforce (#40):
    // release every row the block held back. A header-error block parsed no rows, so this is
    // empty for it — the fix there is a corrected upload, not a Retry.
    const { requeued, purged } = await deps.rowStore.requeueDisbursementRows(disbursement.id);
    if (requeued.length === 0) {
      await annotateWorklistItem(
        deps.mondayClient,
        deps.config,
        itemId,
        purged > 0
          ? purgedReason(purged, retentionDays, true)
          : "Nothing to retry: this block has no held-back rows (its header didn't parse, or every row has " +
              'since been written). If the file was wrong, fix it and upload it as a new file.'
      );
      return { outcome: purged > 0 ? 'row purged' : 'nothing to retry', enqueued: 0, purged };
    }
    if (purged > 0) {
      // Release what can be released; say on the item which rows can't be.
      await annotateWorklistItem(deps.mondayClient, deps.config, itemId, purgedReason(purged, retentionDays, true));
    }
    outcome = 'block';
    transactionIds = requeued;
  }

  // Queued goes on BEFORE the enqueue: once a message is sent the consumer may finish and write
  // Done/Needs review at any moment, and that final label must never be overwritten by Queued.
  await setWorklistLabel(deps.mondayClient, deps.config, itemId, 'queued');
  await sendInBatches(
    deps.queue,
    transactionIds.map((transactionId) => ({ transactionId }))
  );
  return { outcome, enqueued: transactionIds.length };
}
