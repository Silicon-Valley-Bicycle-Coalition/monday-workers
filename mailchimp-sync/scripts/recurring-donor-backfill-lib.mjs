// Pure helpers for scripts/recurring-donor-backfill.mjs, kept apart so vitest can cover them
// without Monday or Mailchimp.

/**
 * Normalized address → whether any People item with that address has Has Active Recurring Gift
 * checked. The same rule the outbound sync applies per item (src/monday/client.ts: a checkbox
 * column's text is non-empty when checked); an address on two items is tagged if either is.
 */
export function desiredByEmail(items, { emailColumn, recurringColumn }) {
  const out = new Map();
  for (const item of items) {
    const email = String(item[emailColumn] ?? '').trim().toLowerCase();
    if (!email.includes('@')) continue;
    const checked = String(item[recurringColumn] ?? '').trim() !== '';
    out.set(email, (out.get(email) ?? false) || checked);
  }
  return out;
}

/**
 * The tag change each audience member needs. Members with no People item are left alone (the
 * Worker never manages them), as are People addresses not in the audience (never created).
 */
export function planTags(desired, members, tag) {
  const plans = [];
  let notInAudience = 0;
  const inAudience = new Set();
  for (const m of members) {
    const email = m.email_address.trim().toLowerCase();
    inAudience.add(email);
    if (!desired.has(email)) continue;
    const want = desired.get(email);
    const has = (m.tags ?? []).some((t) => t.name === tag);
    if (want && !has) plans.push({ email, status: m.status, change: 'add' });
    else if (!want && has) plans.push({ email, status: m.status, change: 'remove' });
  }
  for (const email of desired.keys()) if (!inAudience.has(email)) notInAudience += 1;
  return { plans, notInAudience };
}

/** Counts for the summary. Never holds an address. */
export function summarize(desired, plans, notInAudience) {
  const checked = [...desired.values()].filter(Boolean).length;
  const s = { peopleAddresses: desired.size, checked, notInAudience, add: 0, remove: 0, addByStatus: {} };
  for (const p of plans) {
    s[p.change] += 1;
    if (p.change === 'add') s.addByStatus[p.status] = (s.addByStatus[p.status] ?? 0) + 1;
  }
  return s;
}
