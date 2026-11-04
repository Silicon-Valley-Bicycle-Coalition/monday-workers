// One-off (#55): replaces the Organizations text Partner Type with a single-select dropdown of the
// approved ten values, filled from the text column. Monday can't convert a column's type, so the
// dropdown is a new column placed beside the old one; the swap renames them once every write landed.
//
//   # dry run (default): prints source value -> label with counts; writes nothing
//   MONDAY_API_TOKEN=... tsx scripts/relabel-partner-type.ts --board 123
//   # applies; --expect must equal the dry run's write count, so a board that moved since is refused
//   MONDAY_API_TOKEN=... tsx scripts/relabel-partner-type.ts --board 123 --apply --expect 1225
//
// Safe to re-run after a failure: a set dropdown is left alone, so the next dry run's count is what
// remains. Refuses to apply while any value is unmapped; add it to transform/partnerType.ts first.
// The old column stays, renamed "Partner Type (old text)", until someone deletes it by hand.
//
// Afterwards, views and the Overview still point at the old column's id, so re-resolve them:
//   npm run cli -- configure --rebuild-overviews organizations
import { MondayClient } from '../src/load/monday.js';
import { dropdownLabelDefaults } from '../src/configure/labels.js';
import { BUILDING_TITLE, LIVE_TITLE, RETIRED_TITLE, findPartnerTypeColumns, planRelabel, type RelabelRow } from '../src/repair/partnerTypeDropdown.js';
import { PARTNER_TYPES } from '../src/transform/partnerType.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const boardId = arg('--board');
const apply = process.argv.includes('--apply');
const expected = arg('--expect');
if (!process.env.MONDAY_API_TOKEN) throw new Error('MONDAY_API_TOKEN is not set');
if (!boardId) throw new Error('--board is required');
if (apply && expected === undefined) throw new Error('--apply needs --expect <count from the dry run>');

const client = new MondayClient({ apiUrl: 'https://api.monday.com/v2', token: process.env.MONDAY_API_TOKEN });

type Column = { id: string; title: string; type: string };
const { boards } = await client.gql<{ boards: { name: string; columns: Column[] }[] }>(
  'query ($b: [ID!]) { boards(ids: $b) { name columns { id title type } } }', { b: [boardId] });
const board = boards[0];
if (!board) throw new Error(`board ${boardId} not found`);
const { source, target: existingTarget } = findPartnerTypeColumns(board.columns);
if (!source) throw new Error(`board "${board.name}" has no text "${LIVE_TITLE}" column`);

type Page = { cursor: string | null; items: { id: string; name: string; column_values: { id: string; text: string | null }[] }[] };
const fields = 'cursor items { id name column_values(ids: $c) { id text } }';
const columnIds = [source.id, ...(existingTarget ? [existingTarget.id] : [])];
const rows: RelabelRow[] = [];
let cursor: string | null = null;
do {
  const page: Page = cursor
    ? (await client.gql<{ next_items_page: Page }>(
        `query ($k: String!, $c: [String!]) { next_items_page(limit: 200, cursor: $k) { ${fields} } }`,
        { k: cursor, c: columnIds })).next_items_page
    : (await client.gql<{ boards: { items_page: Page }[] }>(
        `query ($b: [ID!], $c: [String!]) { boards(ids: $b) { items_page(limit: 200) { ${fields} } } }`,
        { b: [boardId], c: columnIds })).boards[0]!.items_page;
  for (const item of page.items) {
    const text = (id: string | undefined) => item.column_values.find((c) => c.id === id)?.text ?? '';
    rows.push({ id: item.id, name: item.name, source: text(source.id), current: text(existingTarget?.id) });
  }
  cursor = page.cursor;
} while (cursor);

const plan = planRelabel(rows);
console.log(`Board "${board.name}" (${boardId}): ${rows.length} items`);
console.log(`\ncount\tlabel\tsource value`);
for (const s of plan.bySource) console.log(`${s.count}\t${s.label}\t${s.source}`);
const labelTotals = PARTNER_TYPES.map((t) => `${t} ${plan.bySource.filter((s) => s.label === t).reduce((n, s) => n + s.count, 0)}`);
console.log(`\nBy label: ${labelTotals.join(', ')}`);
console.log(`To write: ${plan.write.length}; already set: ${plan.alreadySet}; blank, stays Untyped: ${plan.blank}; unmapped: ${plan.unmapped.length}`);
for (const r of plan.unmapped) console.log(`  unmapped\t${r.id}\t${r.source}\t${r.name}`);
console.log(existingTarget ? `Dropdown column: ${existingTarget.id} ("${existingTarget.title}")` : 'Dropdown column: not created yet');

if (!apply) {
  console.log('\nDry run: nothing written.');
} else {
  if (plan.unmapped.length) throw new Error(`${plan.unmapped.length} unmapped value(s); add them to transform/partnerType.ts`);
  if (String(plan.write.length) !== expected) throw new Error(`--expect ${expected}, but ${plan.write.length} rows would be written now; re-run the dry run`);

  const targetId = existingTarget?.id ?? (await client.gql<{ create_column: { id: string } }>(
    `mutation ($b: ID!, $t: String!, $d: JSON, $after: ID) {
       create_column (board_id: $b, title: $t, column_type: dropdown, defaults: $d, after_column_id: $after) { id } }`,
    { b: boardId, t: BUILDING_TITLE, d: dropdownLabelDefaults(PARTNER_TYPES, { single: true }), after: source.id })).create_column.id;

  let written = 0;
  for (const r of plan.write) {
    // No create_labels_if_missing: a label outside the vocabulary must fail, not join the dropdown.
    await client.gql('mutation ($b: ID!, $i: ID!, $c: String!, $v: JSON!) { change_column_value(board_id: $b, item_id: $i, column_id: $c, value: $v) { id } }',
      { b: boardId, i: r.id, c: targetId, v: JSON.stringify({ labels: [r.label] }) });
    written += 1;
    if (written % 100 === 0) console.log(`  ${written}/${plan.write.length}`);
  }
  console.log(`\nWrote ${written} rows.`);

  const rename = (columnId: string, title: string) => client.gql(
    'mutation ($b: ID!, $c: String!, $t: String!) { change_column_title(board_id: $b, column_id: $c, title: $t) { id } }',
    { b: boardId, c: columnId, t: title });
  await rename(source.id, RETIRED_TITLE);
  await rename(targetId, LIVE_TITLE);
  console.log(`Swapped: "${LIVE_TITLE}" is now the dropdown (${targetId}); the old text column is "${RETIRED_TITLE}" (${source.id}).`);
  console.log('Next: npm run cli -- configure --rebuild-overviews organizations');
}
