#!/usr/bin/env node
// Adds the Eventbrite sign-up columns to the Volunteers board and creates its "Recent events" view,
// each only if missing (idempotent by bare column title, so a 🔒 marker never causes a duplicate;
// by name for the view). Dry run by default. Prints the config-ready column ids to paste into
// config/sandbox.json or config/svbc.json under attendeeSync.volunteers.
//
// Usage (from eventbrite-sync/):
//   MONDAY_API_TOKEN=... node scripts/setup-volunteers-board.mjs --board <volunteers id> --events-board <events id> [--apply]
//
// Then run scripts/mark-read-only-columns.mjs for the 🔒 markers. The view needs the board's Date
// column, so the board must already have it (the 📜 Date column the Salesforce import made).

import { fileURLToPath } from 'node:url';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';
import { columnConfig, createColumnVariables, parseArgs, planVolunteersBoard, planView, recentEventsViewVariables, VIEW_NAME } from './setup-volunteers-board-lib.mjs';

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('setup-volunteers-board: MONDAY_API_TOKEN is required');

  // The Worker's own copy of the Monday transport; imported as TypeScript (Node type stripping).
  const { MondayGraphQL } = await import('../src/monday/graphql.ts');
  const monday = new MondayGraphQL('https://api.monday.com/v2', token);
  // Mutations that may have committed throw AmbiguousWriteError instead of retrying into a duplicate.
  const graphql = (query, variables) => monday.request(query, variables, { idempotent: !/^\s*mutation\b/.test(query) });
  const log = (msg) => console.error(`setup-volunteers-board: ${msg}`);

  const read = async () => {
    const data = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { id columns { id title type } views { id name } } }', { ids: [args.board] });
    const board = data.boards?.[0];
    if (!board) throw new Error(`setup-volunteers-board: board ${args.board} not found`);
    return board;
  };
  const board = await read();
  const { toCreate } = planVolunteersBoard(board.columns);
  const { create: createView } = planView(board.views ?? []);
  if (!args.apply) {
    log(`dry run: board ${args.board} needs ${toCreate.map((s) => `"${s.title}"`).join(', ') || 'no columns'}; ${createView ? `would create view "${VIEW_NAME}"` : `view "${VIEW_NAME}" exists`}`);
    return;
  }
  for (const spec of toCreate) {
    await graphql(
      `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON, $description: String) {
         create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults, description: $description) { id } }`,
      createColumnVariables(args.board, spec, args.eventsBoard)
    );
    log(`created "${spec.title}"`);
  }
  const fresh = toCreate.length > 0 ? await read() : board;
  const config = columnConfig(fresh.columns);
  if (createView) {
    const dateColumn = fresh.columns.find((c) => bareTitle(c.title) === 'Date' && c.type === 'date')?.id;
    if (!dateColumn) throw new Error('setup-volunteers-board: the board has no Date column to filter the view on');
    await graphql(
      `mutation ($board: ID!, $name: String, $filter: ItemsQueryGroup, $sort: [ItemsQueryOrderBy!], $settings: TableViewSettingsInput) {
         create_view_table (board_id: $board, name: $name, filter: $filter, sort: $sort, settings: $settings) { id } }`,
      recentEventsViewVariables(args.board, { dateColumn })
    );
    log(`created view "${VIEW_NAME}"`);
  }
  console.log(JSON.stringify({ volunteers: config }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
