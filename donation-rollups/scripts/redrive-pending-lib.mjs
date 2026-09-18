// Pure planning helpers for scripts/redrive-pending.mjs, split out so they can be unit-tested
// without wrangler or the network (same pattern as bootstrap-gifts-lib.mjs).

// One synthetic webhook per distinct owner is enough: the consumer does a full per-owner
// rebuild from the D1 reverse index, so re-driving any one of an owner's stuck donations
// covers all of them. Rows whose owner is unknown to D1 (no donation_links row and no gifts
// row) are sent individually — the Worker resolves the owner from Monday, or marks the row
// written as a benign skip if the donation is unlinked there too.
//
// rows: { donation_item_id, donation_board_id, received_at, owner_item_id | null, gift_owner | null }
// Returns messages in a stable order: owners first (by owner id), then unlinked rows (by
// donation id), so a resumed run sees the same plan as the one it continues.
export function planRedrive(rows) {
  const byOwner = new Map();
  const unlinked = [];
  for (const r of rows) {
    const owner = r.owner_item_id || r.gift_owner || null;
    if (owner === null) { unlinked.push(r); continue; }
    const cur = byOwner.get(owner);
    // Prefer the most recent event for the owner: it's the one most likely to still exist
    // and be linked on Monday.
    if (!cur || r.received_at > cur.received_at) byOwner.set(owner, r);
  }
  const toMessage = (r, ownerItemId) => ({
    donationItemId: String(r.donation_item_id),
    donationBoardId: String(r.donation_board_id),
    ownerItemId,
  });
  const messages = [
    ...[...byOwner.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([owner, r]) => toMessage(r, owner)),
    ...unlinked.sort((a, b) => (a.donation_item_id < b.donation_item_id ? -1 : a.donation_item_id > b.donation_item_id ? 1 : 0)).map((r) => toMessage(r, null)),
  ];
  return { messages, owners: byOwner.size, unlinked: unlinked.length, rows: rows.length };
}

// Splits `items` into chunks; the first is a small canary so a broken deploy or secret fails
// fast on a handful of owners rather than fifty.
export function chunkPlan(items, size, canary = 5) {
  const out = [];
  let i = 0;
  if (items.length > 0 && canary > 0 && canary < size) { out.push(items.slice(0, canary)); i = canary; }
  for (; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// scripts/redrive-pending-bookkeeping.sql is written for hand use with a '{{SINCE}}'
// placeholder; the CLI fills it with the run's start time so only recomputes from this run
// count as covering an owner's other rows.
export function renderBookkeepingSql(template, sinceISO) {
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(sinceISO)) throw new Error(`renderBookkeepingSql: sinceISO must be an ISO UTC timestamp, got "${sinceISO}"`);
  if (!template.includes('{{SINCE}}')) throw new Error('renderBookkeepingSql: template has no {{SINCE}} placeholder');
  return template.replaceAll('{{SINCE}}', sinceISO);
}
