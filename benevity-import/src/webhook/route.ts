import { Hono } from 'hono';
import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementStore, NewDisbursement } from '../db/disbursements';
import type { RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';
import { parseBenevityReport, type ParsedBlock } from '../parse/report';
import { isChallenge, validateUploadEvent } from './validate';
import { createWorklistItem } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';
import type { BenevityQueueMessage } from '../consumer/processBatch';

export interface QueueLike {
  send(message: BenevityQueueMessage): Promise<void>;
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
    if (deps.webhookSecret === undefined || c.req.query('secret') !== deps.webhookSecret) {
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

  // Resume, don't restart: a retry of a stuck upload re-fetches and re-parses the SAME asset,
  // which is a pure function of its bytes, so block order is stable across attempts. Each
  // ingestBlock call creates exactly one `disbursements` row and runs to completion before
  // returning (no partial state), so the count of disbursement rows already recorded for this
  // upload is exactly how many leading blocks were already fully handled — skip those, and
  // only process what's left. Without this, a retry would re-run every already-succeeded block
  // too: another `disbursements` row per block, and for a needs-review block, another
  // duplicate worklist item.
  const alreadyProcessedCount = (await deps.disbursementStore.listByUpload(upload.id)).length;

  try {
    for (const block of blocks.slice(alreadyProcessedCount)) {
      await ingestBlock(block, upload.id, deps);
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

async function ingestBlock(block: ParsedBlock, uploadId: number, deps: AppDeps): Promise<void> {
  const needsReview = block.headerError !== null || block.sumMismatch;
  const reviewReason =
    block.headerError ?? (block.sumMismatch ? 'row totals do not match the reported gross total' : null);

  const newDisbursement: NewDisbursement = {
    uploadId,
    disbursementId: block.disbursementId,
    periodEnding: block.periodEnding,
    currency: block.currency,
    rowCount: block.rows.length,
    reportedGrossTotal: block.reportedGrossTotal,
    reportedNetTotal: block.reportedNetTotal,
    needsReview,
    reviewReason,
  };
  const disbursement = await deps.disbursementStore.createDisbursement(newDisbursement);

  if (needsReview) {
    await createWorklistItem(deps.mondayClient, deps.config, {
      reason: reviewReason ?? 'block needs review',
      name: `Disbursement ${block.disbursementId || '(unknown)'}`,
      email: '',
      company: block.charityName,
      amount: block.reportedGrossTotal,
      date: block.periodEnding || deps.now().slice(0, 10),
    });
    // Every row is recorded so nothing is silently lost, but none are enqueued — spec: "a
    // mismatch marks the whole block needs-review rather than writing partial data from a
    // block the parser may have mis-split."
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
      await deps.queue.send({ transactionId: row.transactionId });
    }
  }
}
