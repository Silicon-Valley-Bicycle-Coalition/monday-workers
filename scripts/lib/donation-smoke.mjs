// Pure helpers for scripts/smoke-donation-entry.mjs: what a manual gift entered through the
// "Enter a gift" form should end up looking like on the Donations board, and the checks on it.

import { bareTitle } from './column-titles.mjs';

// Acknowledgment Tier by Amount: the board's own automations set it on create and on Amount change
// (Major at $200 and up), and donation-rollups' classify backs them up nightly.
export const MAJOR_TIER_AT = 200;
export function expectedTier(amount) {
  return amount >= MAJOR_TIER_AT ? 'Major' : 'Standard';
}

// The scenarios the smoke test creates. `donor` says whether the gift links the test donor; `status`
// defaults to Received. A pledge has a Pledge Date and no Date until it is paid.
export const SCENARIOS = [
  { name: 'SMOKE person check', amount: 250, donor: true, anonymous: false },
  { name: 'SMOKE anonymous cash', amount: 40, donor: false, anonymous: true },
  { name: 'SMOKE pledge', amount: 300, donor: true, anonymous: false, status: 'Pledged' },
];

// Column titles the script needs on the Donations board (bare titles; markers are ignored).
export const NEEDED_COLUMNS = [
  'Amount', 'Date', 'Status', 'Gift Type', 'Donor', 'Anonymous Donor', 'Payment Method',
  'Check/Reference Number', 'Acknowledgment Tier', 'Pledge Date',
];

// Pure. `columns` is the board's [{ id, title }]. Returns { byTitle: Map, missing: [titles] }.
export function resolveColumns(columns) {
  const byTitle = new Map(columns.map((c) => [bareTitle(c.title), c.id]));
  const missing = NEEDED_COLUMNS.filter((t) => !byTitle.has(t));
  return { byTitle, missing };
}

// Pure. The create_item column_values for a scenario (what the form writes).
export function columnValues(cols, scenario, { donorItemId, dateISO }) {
  const v = {
    [cols.get('Amount')]: String(scenario.amount),
    [cols.get('Status')]: { label: scenario.status ?? 'Received' },
    [cols.get('Gift Type')]: 'Donation',
  };
  if (scenario.status === 'Pledged') {
    v[cols.get('Pledge Date')] = { date: dateISO };
  } else {
    v[cols.get('Date')] = { date: dateISO };
    v[cols.get('Payment Method')] = 'Cash/Check';
    v[cols.get('Check/Reference Number')] = 'SMOKE-TEST';
  }
  if (scenario.donor) v[cols.get('Donor')] = { item_ids: [Number(donorItemId)] };
  if (scenario.anonymous) v[cols.get('Anonymous Donor')] = { checked: 'true' };
  return v;
}

// Pure. The two writes that mark a pledge paid, in order. Neither alone may count the gift.
export function paymentSteps(cols, { dateISO }) {
  return [
    { [cols.get('Date')]: { date: dateISO } },
    { [cols.get('Status')]: { label: 'Received' } },
  ];
}

// Pure. `item` is { text: Map(columnId -> text), donorIds: [..] } read back after the wait.
// Returns the list of problems with that item for the scenario.
export function checkItem(cols, scenario, item) {
  const problems = [];
  const tier = item.text.get(cols.get('Acknowledgment Tier')) ?? '';
  if (tier !== expectedTier(scenario.amount)) {
    problems.push(`${scenario.name}: Acknowledgment Tier is "${tier}", expected "${expectedTier(scenario.amount)}"`);
  }
  const status = scenario.status ?? 'Received';
  if ((item.text.get(cols.get('Status')) ?? '') !== status) {
    problems.push(`${scenario.name}: Status is "${item.text.get(cols.get('Status')) ?? ''}", expected "${status}"`);
  }
  const date = item.text.get(cols.get('Date')) ?? '';
  if (status === 'Pledged' && date !== '') problems.push(`${scenario.name}: Date is "${date}", expected blank`);
  if (scenario.donor && item.donorIds.length !== 1) {
    problems.push(`${scenario.name}: expected 1 linked donor, found ${item.donorIds.length}`);
  }
  if (!scenario.donor && item.donorIds.length !== 0) {
    problems.push(`${scenario.name}: expected no linked donor, found ${item.donorIds.length}`);
  }
  return problems;
}

// Pure. Lifetime Giving before/after, as numbers; the gift counted if it rose by `amount`.
export function rollupMoved(before, after, amount) {
  return Number.isFinite(before) && Number.isFinite(after) && Math.abs(after - before - amount) < 0.005;
}
