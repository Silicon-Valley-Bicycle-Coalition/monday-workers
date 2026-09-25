import { Hono, type Context } from 'hono';
import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementStore } from '../db/disbursements';
import type { RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';
import { parseBenevityReport, type ParsedBlock } from '../parse/report';
import { isChallenge, validateRetryEvent, validateUploadEvent } from './validate';
import { blockWorklistKey, ensureWorklistItem, setWorklistLabel } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';
import type { BenevityQueueMessage } from '../consumer/processBatch';
import { sendInBatches, type BatchSender } from '../util/sendBatch';

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

    for (const assetId of event.assetIds) {
      try {
        await ingestAsset(assetId, deps);
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
  const needsReview = block.headerError !== null || block.sumMismatch;
  const reviewReason =
    block.headerError ?? (block.sumMismatch ? 'row totals do not match the reported gross total' : null);

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

  if (needsReview) {
    if (disbursement.worklistItemId === null) {
      // One worklist item per block, ever: skipped once its id is recorded (a resumed attempt, or
      // the same disbursement re-uploaded), and adopted rather than re-posted if an earlier
      // attempt created it but died before recording it (#34).
      const worklistItemId = await ensureWorklistItem(
        deps.mondayClient,
        deps.config,
        {
          key: blockWorklistKey(block.disbursementId, assetId, blockIndex),
          reason: reviewReason ?? 'block needs review',
          name: `Disbursement ${block.disbursementId || '(unknown)'}`,
          email: '',
          company: block.charityName,
          amount: block.reportedGrossTotal,
          date: block.periodEnding || deps.now().slice(0, 10),
        },
        null
      );
      await deps.disbursementStore.setWorklistItemId(disbursement.id, worklistItemId);
    }
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
    if (row.donationDate < deps.config.benevityImport.minDonationDate) {
      await deps.rowStore.upsertRow({
        transactionId: row.transactionId,
        disbursementId: disbursement.id,
        rawRow: JSON.stringify(row),
        status: 'skipped',
        ingestedAt: deps.now(),
      });
      continue;
    }

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
  outcome: 'row' | 'block' | 'row already written' | 'row skipped' | 'unknown item';
  enqueued: number;
}

async function replayWorklistItem(itemId: string, deps: AppDeps): Promise<ReplayResult> {
  let outcome: ReplayResult['outcome'];
  let transactionIds: string[];

  const row = await deps.rowStore.getRowByWorklistItemId(itemId);
  if (row !== null) {
    if (row.status === 'written' || row.status === 'skipped') {
      // Nothing to redo. Say so on the board rather than leaving the item at Retry.
      await setWorklistLabel(deps.mondayClient, deps.config, itemId, 'done');
      return { outcome: row.status === 'written' ? 'row already written' : 'row skipped', enqueued: 0 };
    }
    outcome = 'row';
    transactionIds = await deps.rowStore.requeueRow(row.transactionId);
  } else {
    const disbursement = await deps.disbursementStore.getByWorklistItemId(itemId);
    if (disbursement === null) {
      // Not an item this Worker posted (or its D1 record is gone) — nothing to replay.
      return { outcome: 'unknown item', enqueued: 0 };
    }
    // Staff have checked the block (e.g. its totals mismatch was a Benevity rounding quirk):
    // release every row the block held back. A header-error block parsed no rows, so this is
    // empty for it — the fix there is a corrected upload, not a Retry.
    outcome = 'block';
    transactionIds = await deps.rowStore.requeueDisbursementRows(disbursement.id);
  }

  await sendInBatches(
    deps.queue,
    transactionIds.map((transactionId) => ({ transactionId }))
  );
  await setWorklistLabel(deps.mondayClient, deps.config, itemId, 'queued');
  return { outcome, enqueued: transactionIds.length };
}
