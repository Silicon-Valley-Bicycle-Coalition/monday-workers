// One-off: moves Events rows that are already over from Upcoming to Completed, for the rows loaded
// before the transform stopped trusting Eventbrite's `started`. Only touches Event Status.
//
//   # dry run (default): lists what would change; writes nothing
//   MONDAY_API_TOKEN=... tsx scripts/complete-past-upcoming-events.ts --board 123 [--today 2026-11-03]
//   # applies; --expect must equal the dry run's count, so a board that moved since is refused
//   MONDAY_API_TOKEN=... tsx scripts/complete-past-upcoming-events.ts --board 123 --apply --expect 84
//
// An event ends "before today" by End, or Date when End is blank. `today` defaults to the Pacific
// date. Undated Upcoming rows are listed and left alone.
import { bareTitle } from '../../scripts/lib/column-titles.mjs';
import { MondayClient } from '../src/load/monday.js';
import { classifyUpcomingEvents, type UpcomingEvent } from '../src/repair/pastUpcomingEvents.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const boardId = arg('--board');
const apply = process.argv.includes('--apply');
const expected = arg('--expect');
const today = arg('--today') ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
if (!process.env.MONDAY_API_TOKEN) throw new Error('MONDAY_API_TOKEN is not set');
if (!boardId) throw new Error('--board is required');
if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('--today must be YYYY-MM-DD');
if (apply && !expected) throw new Error('--apply needs --expect <count from the dry run>');

const client = new MondayClient({ apiUrl: 'https://api.monday.com/v2', token: process.env.MONDAY_API_TOKEN });

type Column = { id: string; title: string; settings_str: string };
const { boards } = await client.gql<{ boards: { name: string; columns: Column[] }[] }>(
  'query ($b: [ID!]) { boards(ids: $b) { name columns { id title settings_str } } }', { b: [boardId] });
const board = boards[0];
if (!board) throw new Error(`board ${boardId} not found`);
const column = (title: string): Column => {
  const c = board.columns.find((x) => bareTitle(x.title) === title);
  if (!c) throw new Error(`board "${board.name}" has no "${title}" column`);
  return c;
};
const statusColumn = column('Event Status');
const dateId = column('Date').id;
const endId = column('End').id;
const labels = (JSON.parse(statusColumn.settings_str) as { labels: Record<string, string> }).labels;
const upcomingIndex = Object.entries(labels).find(([, l]) => l === 'Upcoming')?.[0];
if (upcomingIndex === undefined || !Object.values(labels).includes('Completed')) {
  throw new Error('Event Status needs both an Upcoming and a Completed label');
}

type Page = { cursor: string | null; items: { id: string; name: string; column_values: { id: string; text: string | null }[] }[] };
const fields = 'cursor items { id name column_values(ids: $c) { id text } }';
const rows: UpcomingEvent[] = [];
let cursor: string | null = null;
do {
  const page: Page = cursor
    ? (await client.gql<{ next_items_page: Page }>(
        `query ($k: String!, $c: [String!]) { next_items_page(limit: 200, cursor: $k) { ${fields} } }`,
        { k: cursor, c: [statusColumn.id, dateId, endId] })).next_items_page
    : (await client.gql<{ boards: { items_page: Page }[] }>(
        `query ($b: [ID!], $c: [String!], $s: ID!, $v: CompareValue!) { boards(ids: $b) { items_page(limit: 200, query_params: { rules: [{ column_id: $s, compare_value: $v, operator: any_of }] }) { ${fields} } } }`,
        { b: [boardId], c: [statusColumn.id, dateId, endId], s: statusColumn.id, v: [Number(upcomingIndex)] })).boards[0]!.items_page;
  for (const item of page.items) {
    const text = (id: string) => item.column_values.find((c) => c.id === id)?.text ?? '';
    rows.push({ id: item.id, name: item.name, status: text(statusColumn.id), date: text(dateId), end: text(endId) });
  }
  cursor = page.cursor;
} while (cursor);

const { complete, keep, undated } = classifyUpcomingEvents(rows, today);
const byEnd = (a: UpcomingEvent, b: UpcomingEvent) => (a.end || a.date).localeCompare(b.end || b.date);
const print = (heading: string, list: UpcomingEvent[]) => {
  console.log(`\n${heading} (${list.length})`);
  for (const r of [...list].sort(byEnd)) console.log([r.id, r.date, r.end, r.name].join('\t'));
};
console.log(`Board "${board.name}" (${boardId}), today ${today}: ${rows.length} Upcoming`);
print('Upcoming -> Completed', complete);
print('Stays Upcoming', keep);
print('No date, left alone', undated);

if (!apply) {
  console.log('\nDry run: nothing written.');
} else {
  if (String(complete.length) !== expected) throw new Error(`--expect ${expected}, but ${complete.length} rows match now; re-run the dry run`);
  for (const r of complete) {
    await client.gql('mutation ($b: ID!, $i: ID!, $c: String!) { change_simple_column_value(board_id: $b, item_id: $i, column_id: $c, value: "Completed") { id } }',
      { b: boardId, i: r.id, c: statusColumn.id });
  }
  console.log(`\nWrote ${complete.length} rows to Completed.`);
}
