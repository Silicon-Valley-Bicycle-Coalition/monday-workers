// Pure helpers for scripts/replay-window.mjs, split out so they can be unit-tested without
// wrangler or the network (same pattern as redrive-failed-lib.mjs, whose planRedrive this reuses).

export { planRedrive } from './redrive-failed-lib.mjs';

// Funraise's drawer Test button sends transaction id -1 ("Lorem Ipsum", donor@example.com). It is
// never a real gift, and replaying it would create a fake donor and Donations item in production.
export const TEST_TRANSACTION_ID = '-1';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

// SQL for every transaction the source Worker received in [since, until), whatever its status.
// Unlike selectFailedSql this does not filter on status: the deliveries in the cutover gap are
// `written` in the sandbox ledger (the sandbox Worker wrote them to the sandbox boards), and
// those are exactly the ones to replay. Timestamps are validated because the script passes the
// result to `wrangler d1 execute --command`. received_at holds `new Date().toISOString()`, so
// string comparison orders it correctly. An edit replaces the row and its received_at, so the
// window also catches edits to gifts first seen earlier.
export function selectWindowSql(since, until = null) {
  if (typeof since !== 'string' || !ISO_UTC.test(since)) {
    throw new Error('replay-window: --since must be an ISO UTC timestamp, e.g. 2026-10-09T17:30:00.000Z');
  }
  if (until !== null && (typeof until !== 'string' || !ISO_UTC.test(until))) {
    throw new Error('replay-window: --until must be an ISO UTC timestamp');
  }
  const upper = until === null ? '' : ` AND received_at < '${until}'`;
  return (
    `SELECT entity_id, sent_at, raw_payload, status, error, received_at FROM events ` +
    `WHERE entity_type = 'transaction' AND entity_id != '${TEST_TRANSACTION_ID}' ` +
    `AND received_at >= '${since}'${upper} ORDER BY received_at, entity_id`
  );
}

// What the production route's answer means for a replay. Replays are idempotent, so 'duplicate'
// is a correct outcome, not a failure: the route answers `{ok:true,duplicate:true}` when it
// already holds this exact delivery, or a newer one (the stale-delivery guard), and does nothing.
//   enqueued  — new delivery accepted and queued for the Monday write
//   duplicate — already present; nothing to do
//   auth      — wrong or missing secret; every later delivery would fail the same way
//   failed    — anything else (5xx, a rejected payload shape, a network answer we can't read)
export function classifyReplayResponse(status, bodyText) {
  if (status === 401) return 'auth';
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  if (status >= 200 && status < 300 && body !== null && typeof body === 'object' && body.ok === true) {
    return body.duplicate === true ? 'duplicate' : 'enqueued';
  }
  return 'failed';
}
