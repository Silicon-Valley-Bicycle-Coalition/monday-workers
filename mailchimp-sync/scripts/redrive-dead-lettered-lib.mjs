// Pure planning helpers for scripts/redrive-dead-lettered.mjs, split out so they can be
// unit-tested without wrangler or the network (same pattern as funraise-sync's
// redrive-failed-lib.mjs and donation-rollups' redrive-pending-lib.mjs).
import md5 from 'md5';

// Must match DEAD_LETTER_PREFIX in src/consumer/deadLetters.ts.
export const DEAD_LETTER_PREFIX = 'dead-lettered after retries: ';

const DIRECTIONS = {
  outbound: { table: 'pending_outbound_syncs', keyColumn: 'donor_item_id', path: '/webhooks/monday/donors', secretEnv: 'MONDAY_WEBHOOK_SECRET' },
  inbound: { table: 'pending_inbound_syncs', keyColumn: 'email', path: '/webhooks/mailchimp/audience', secretEnv: 'MAILCHIMP_WEBHOOK_SECRET' },
};

export function directionInfo(direction) {
  const info = DIRECTIONS[direction];
  if (info === undefined) throw new Error(`redrive-dead-lettered: unknown direction "${direction}" (outbound, inbound, or both)`);
  return info;
}

// --direction: outbound | inbound | both (default).
export function parseDirections(value) {
  if (value === undefined || value === 'both') return ['outbound', 'inbound'];
  directionInfo(value);
  return [value];
}

// --since / --until: YYYY-MM-DD or an ISO UTC timestamp, normalized to the same
// toISOString() form the Worker writes to received_at so string comparison in SQL is exact.
export function parseBound(value) {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z)?$/.test(value)) {
    throw new Error(`redrive-dead-lettered: "${value}" is not YYYY-MM-DD or an ISO UTC timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`redrive-dead-lettered: "${value}" is not a valid date`);
  return date.toISOString();
}

// SQL for the dead-lettered rows of one direction. Only rows the DLQ consumer marked
// (status 'failed' + the prefix) — a plain 'failed' row may still be mid-retry on the queue.
// Bounds are re-validated here because the result goes to `wrangler d1 execute --command`.
export function selectDeadLetteredSql(direction, { since, until } = {}) {
  const { table, keyColumn } = directionInfo(direction);
  const where = [`status = 'failed'`, `error LIKE '${DEAD_LETTER_PREFIX}%'`];
  if (since !== undefined) where.push(`received_at >= '${parseBound(since)}'`);
  if (until !== undefined) where.push(`received_at < '${parseBound(until)}'`);
  return `SELECT ${keyColumn} AS key, error, received_at FROM ${table} WHERE ${where.join(' AND ')} ORDER BY received_at, ${keyColumn}`;
}

// How a row is named in output: the Monday Donor item id (outbound) or the Mailchimp member id
// — MD5 of the lowercased address, the subscriber hash Mailchimp's API and UI use — (inbound),
// so the script never prints an email address. Matches the DLQ consumer's log lines.
export function displayId(direction, key) {
  return direction === 'inbound' ? md5(String(key).trim().toLowerCase()) : String(key);
}

// Each row becomes the webhook delivery that originally enqueued it, POSTed back through the
// Worker's own route, which upserts the pending row (status 'received', error cleared) and
// enqueues it: the same path a real Monday / Mailchimp delivery takes. Both consumers re-read
// the current state (the Donor's columns / the member's interests) rather than trusting the
// payload, so a minimal payload is enough. The outbound payload carries no columnId, so the
// route's self-inflicted-event skip can't swallow it. `ids` filters by displayId.
export function planRedrive(direction, rows, { ids } = {}) {
  const { path } = directionInfo(direction);
  const wanted = ids && ids.length > 0 ? new Set(ids.map(String)) : null;
  const deliveries = [];
  for (const r of rows) {
    const id = displayId(direction, r.key);
    if (wanted !== null && !wanted.has(id)) continue;
    const delivery =
      direction === 'outbound'
        ? { contentType: 'application/json', body: JSON.stringify({ event: { type: 'redrive', pulseId: String(r.key) } }) }
        : { contentType: 'application/x-www-form-urlencoded', body: new URLSearchParams({ type: 'profile', 'data[email]': String(r.key) }).toString() };
    deliveries.push({ direction, id, error: r.error ?? null, receivedAt: r.received_at, path, ...delivery });
  }
  return deliveries.sort((a, b) =>
    a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : a.id.localeCompare(b.id),
  );
}

// A recorded error is usually an HTTP status and message, but an upstream error body can echo
// the address; mask anything email-shaped before printing.
export function redactEmails(text) {
  return text === null || text === undefined ? text : String(text).replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g, '<email>');
}

// Both routes check the shared secret in the ?secret= query parameter — the only place Monday
// and Mailchimp can put it — so the replay does too. Never print the result.
export function redriveUrl(workerUrl, path, secret) {
  return `${workerUrl.replace(/\/$/, '')}${path}?secret=${encodeURIComponent(secret)}`;
}
