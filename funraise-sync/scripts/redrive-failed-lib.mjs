// Pure planning helpers for scripts/redrive-failed.mjs, split out so they can be unit-tested
// without wrangler or the network (same pattern as donation-rollups' redrive-pending-lib.mjs).

// rows: { entity_id, sent_at | null, raw_payload, status, error, received_at } from D1 `events`.
// Each replayable row becomes the Funraise envelope it arrived in — `{ sentAt, event, data }`
// with the stored (already PII-stripped) `data` — so the route derives the same event_id
// (`<id>:<sentAt>`), hits ON CONFLICT (event_id) DO NOTHING, sees the row is 'failed' and
// re-enqueues it: the same recovery path a genuine Funraise redelivery takes. Rows whose payload
// the retention purge already emptied can't be replayed and are reported instead.
// Output is sorted by received_at, then entity id, so a resumed run sees the same plan.
export function planRedrive(rows) {
  const sorted = [...rows].sort((a, b) =>
    a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : String(a.entity_id).localeCompare(String(b.entity_id))
  );
  const deliveries = [];
  const unreplayable = [];
  for (const r of sorted) {
    let data = null;
    try {
      data = JSON.parse(r.raw_payload);
    } catch {
      data = null;
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length === 0) {
      unreplayable.push({ entityId: String(r.entity_id), reason: 'raw_payload purged or unparseable' });
      continue;
    }
    const envelope = { event: 'DONATION', data };
    if (r.sent_at !== null && r.sent_at !== undefined) envelope.sentAt = Number(r.sent_at);
    deliveries.push({ entityId: String(r.entity_id), error: r.error ?? null, envelope });
  }
  return { deliveries, unreplayable };
}

// SQL for the rows to re-drive. Statuses and the cutoff are validated here because the script
// passes the result to `wrangler d1 execute --command`. Only 'failed' and 'received' are
// accepted: those are the statuses the route re-enqueues on an identical redelivery
// (src/webhook/route.ts); any other status would come back { duplicate: true } and do nothing.
export function selectFailedSql(statuses, receivedBefore) {
  const allowed = new Set(['failed', 'received']);
  for (const s of statuses) {
    if (!allowed.has(s)) throw new Error(`redrive-failed: unsupported status "${s}"`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(receivedBefore)) throw new Error('redrive-failed: cutoff must be an ISO UTC timestamp');
  const list = statuses.map((s) => `'${s}'`).join(',');
  return (
    `SELECT entity_id, sent_at, raw_payload, status, error, received_at FROM events ` +
    `WHERE entity_type = 'transaction' AND status IN (${list}) AND received_at < '${receivedBefore}' ` +
    `ORDER BY received_at, entity_id`
  );
}
