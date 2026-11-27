// Pure helpers for compare-donation-shape.mjs: no wrangler, no network, so node:test covers them.
//
// The question (IT Requests "funraise-sync should re-read each gift from Funraise"): does
// GET /api/v1/crm/donation/{id} return the same shape, under the same id, as the webhook's `data`
// object the consumer maps today? The report names paths and whether they agree, never values:
// both sides carry donor PII.

// The webhook paths the consumer reads, taken from the config so a fork's mapping is checked too,
// plus the fixed paths in src/consumer (processBatch.ts, employerAnswer.ts).
const FIXED_PATHS = ['id', 'donationDate', 'subscription.id', 'subscription.sequence', 'fundraisingEvent', 'companyMatch.companyName'];

export function mappedPaths(funraiseSync) {
  const paths = new Set(FIXED_PATHS);
  for (const [key, value] of Object.entries(funraiseSync)) {
    if (key === 'doNotMigrateFields') continue;
    if (key.endsWith('Field') && typeof value === 'string') paths.add(value);
    if (key === 'emailFieldPrecedence' && Array.isArray(value)) value.forEach((v) => paths.add(v));
  }
  for (const path of Object.keys(funraiseSync.columnMap ?? {})) paths.add(path);
  return [...paths].sort();
}

// Every leaf as path → value. Arrays are leaves (compared whole): the mapping never indexes into one.
export function leaves(obj, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) leaves(value, path, out);
    else out.set(path, value);
  }
  return out;
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// Values that are equal once the webhook's number-or-string looseness is allowed for
// (validate.ts already accepts an id as either).
function sameValue(a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  const scalar = (v) => typeof v === 'number' || typeof v === 'string';
  return scalar(a) && scalar(b) && String(a) === String(b);
}

function compare(webhook, api, path) {
  const inW = webhook.has(path);
  const inA = api.has(path);
  if (!inW && !inA) return { path, verdict: 'absent-both' };
  if (!inA) return { path, verdict: 'missing-from-api', webhookType: typeOf(webhook.get(path)) };
  if (!inW) return { path, verdict: 'only-in-api', apiType: typeOf(api.get(path)) };
  const w = webhook.get(path);
  const a = api.get(path);
  return {
    path,
    verdict: sameValue(w, a) ? 'same' : 'differs',
    webhookType: typeOf(w),
    apiType: typeOf(a),
  };
}

// mapped: one row per path the consumer reads. other: every remaining leaf on either side.
// linesUp: every mapped path the webhook carries is present and equal in the API record.
export function compareShapes(webhookData, apiRecord, mapped) {
  const w = leaves(webhookData);
  const a = leaves(apiRecord);
  const mappedRows = mapped.map((p) => compare(w, a, p));
  const mappedSet = new Set(mapped);
  const rest = [...new Set([...w.keys(), ...a.keys()])].filter((p) => !mappedSet.has(p)).sort();
  const otherRows = rest.map((p) => compare(w, a, p));
  const linesUp = mappedRows.every((r) => r.verdict === 'same' || r.verdict === 'absent-both');
  return { mapped: mappedRows, other: otherRows, linesUp };
}

export function formatRow(r) {
  const types = r.webhookType || r.apiType ? ` (webhook ${r.webhookType ?? '-'}, api ${r.apiType ?? '-'})` : '';
  return `  ${r.verdict.padEnd(16)} ${r.path}${types}`;
}

// Newest written transaction whose payload hasn't been purged; Funraise's Test-button id -1 never
// exists in the API.
export function latestWrittenSql() {
  return (
    `SELECT entity_id, sent_at, raw_payload FROM events WHERE entity_type = 'transaction' ` +
    `AND status = 'written' AND entity_id != '-1' AND raw_payload != '' ORDER BY received_at DESC LIMIT 1`
  );
}

export function byIdSql(entityId) {
  if (!/^\d+$/.test(entityId)) throw new Error('compare-donation-shape: --id must be a numeric Funraise transaction id');
  return (
    `SELECT entity_id, sent_at, raw_payload FROM events WHERE entity_type = 'transaction' ` +
    `AND entity_id = '${entityId}' AND raw_payload != '' ORDER BY received_at DESC LIMIT 1`
  );
}
