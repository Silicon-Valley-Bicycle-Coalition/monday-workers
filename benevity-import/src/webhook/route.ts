import { Hono, type Context } from 'hono';
import type { MondayClient } from '../monday/client';
import type { UploadStore } from '../db/uploads';
import type { DisbursementStore } from '../db/disbursements';
import type { RowStore } from '../db/rows';
import type { BenevityImportConfig } from '../types';
import { isChallenge, validateRetryEvent, validateUploadEvent } from './validate';
import { annotateWorklistItem, setWorklistLabel } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';
import type { BenevityQueueMessage } from '../consumer/processBatch';
import { sendInBatches, type BatchSender } from '../util/sendBatch';
import { logSkip, stampFor } from '../flags';
import type { BatchSkipContext } from '../writeSwitch';

// Queue producer surface the routes need. Messages are sent with sendBatch (chunked to Queues' 100
// messages / 256 KB per call, see util/sendBatch.ts) rather than one send() per message, so a
// block Retry doesn't spend one subrequest per row inside the webhook request.
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
  // Monday call, and under `off` the upload route stamps what it enqueues `dropped`.
  gate: () => Promise<BatchSkipContext>;
  // Shared secret required as `?secret=...` on the registered Monday webhook URL
  // (`wrangler secret put BENEVITY_WEBHOOK_SECRET`). Fails closed when unset.
  webhookSecret: string | undefined;
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

    // The payload is only as trustworthy as the URL secret (#106): don't ingest any asset id it
    // names. The event must come from the Uploads board, and every asset must really be attached
    // to that item there. Monday is asked, so a forged payload can't vouch for itself.
    const uploadsBoardId = deps.config.monday.boards.benevityUploads;
    if (uploadsBoardId === null || event.boardId !== String(uploadsBoardId)) {
      console.error(`benevity webhook: refused item "${event.itemId}": event is not from the Uploads board`);
      return c.json({ ok: true, ignored: true }, 200);
    }
    let attached;
    try {
      attached = await deps.mondayClient.fetchItemAssets(event.itemId);
    } catch (err) {
      console.error(`benevity webhook: failed to verify item "${event.itemId}": ${errorMessage(err)}`);
      return c.json({ ok: false }, 500); // Monday redelivers
    }
    if (attached === null || attached.boardId !== String(uploadsBoardId)) {
      console.error(`benevity webhook: refused item "${event.itemId}": not an item on the Uploads board`);
      return c.json({ ok: true, ignored: true }, 200);
    }
    const onItem = new Set(attached.assetIds);
    const assetIds = event.assetIds.filter((id) => onItem.has(id));
    if (assetIds.length !== event.assetIds.length) {
      console.error(`benevity webhook: item "${event.itemId}": ignored ${event.assetIds.length - assetIds.length} asset id(s) not attached to it`);
    }

    // Record and enqueue; the consumer fetches, parses and ingests the file (#74), so a large
    // report costs this request a few D1 calls and one queue send, never a parse or a row loop.
    // Recording the upload here is what lets a redelivery of a fully ingested asset stop at once.
    const stamp = stampFor(gate.mode);
    const messages: BenevityQueueMessage[] = [];
    try {
      for (const assetId of assetIds) {
        const existing = await deps.uploadStore.getUploadByAssetId(assetId);
        if (existing?.status === 'parsed') continue; // a redelivery of a fully ingested asset
        // Anything else is (re-)enqueued: a new upload, one whose earlier send never went
        // through, or one at 'error' or stuck at 'parsing'. A duplicate message is harmless —
        // the consumer runs one at a time and the second finds the upload 'parsed', or resumes.
        if (existing === null) await deps.uploadStore.createUpload(assetId, deps.now());
        messages.push({ assetId, ...stamp });
      }
      await sendInBatches(deps.queue, messages);
    } catch (err) {
      console.error(`benevity webhook: failed to record item "${event.itemId}"'s upload: ${errorMessage(err)}`);
      return c.json({ ok: false }, 500); // Monday redelivers; recording and enqueueing are safe to repeat
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
