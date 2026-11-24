#!/usr/bin/env node
// Adds the Eventbrite sign-up columns to the Volunteers board, the Shift Lead columns to Events, the
// columns Monday works out from the linked event, and the "Recent events" and "Upcoming by event"
// views, each only if missing (idempotent by bare column title, so a 🔒 marker never causes a
// duplicate; by name for the views). Dry run by default. Prints the config-ready column ids to paste
// into config/sandbox.json or config/svbc.json under attendeeSync.volunteers.
//
// Usage (from eventbrite-sync/):
//   MONDAY_API_TOKEN=... node scripts/setup-volunteers-board.mjs --board <volunteers id> --events-board <events id> \
//     --people-boards <people id>,<people historical id> [--apply]
//
// Then run scripts/mark-read-only-columns.mjs for the 🔒 markers. The views need the board's Date and
// Status columns, which the Salesforce import made (📜).

import { fileURLToPath } from 'node:url';
import { bareTitle } from '../../scripts/lib/column-titles.mjs';
import {
  UPCOMING_VIEW_NAME, VIEW_NAME, canceledLabelId, columnConfig, createColumnVariables, derivedColumnVariables, leadEmailVariables, parseArgs,
  planDerivedColumns, planEventsColumns, planViews, planVolunteersBoard, recentEventsViewVariables, shiftLeadVariables, upcomingViewVariables,
} from './setup-volunteers-board-lib.mjs';

const CREATE_COLUMN = `mutation ($board: ID!, $title: String!, $type: ColumnType!, $defaults: JSON, $description: String) {
  create_column (board_id: $board, title: $title, column_type: $type, defaults: $defaults, description: $description) { id } }`;
const CREATE_VIEW = `mutation ($board: ID!, $name: String, $filter: ItemsQueryGroup, $sort: [ItemsQueryOrderBy!], $settings: TableViewSettingsInput) {
  create_view_table (board_id: $board, name: $name, filter: $filter, sort: $sort, settings: $settings) { id } }`;

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

  const read = async (id) => {
    const data = await graphql('query ($ids: [ID!]) { boards(ids: $ids) { id columns { id title type settings_str } views { id name } } }', { ids: [id] });
    const board = data.boards?.[0];
    if (!board) throw new Error(`setup-volunteers-board: board ${id} not found`);
    return board;
  };
  const find = (board, title, type) => {
    const column = board.columns.find((c) => bareTitle(c.title) === title && c.type === type);
    if (!column) throw new Error(`setup-volunteers-board: board ${board.id} has no ${type} column "${title}"`);
    return column;
  };
  const createColumn = async (variables) => {
    await graphql(CREATE_COLUMN, variables);
    log(`created "${variables.title}" on board ${variables.board}`);
  };

  let volunteers = await read(args.board);
  let events = await read(args.eventsBoard);
  const { toCreate } = planVolunteersBoard(volunteers.columns);
  const onEvents = planEventsColumns(events.columns);
  const derived = planDerivedColumns(volunteers.columns);
  const views = planViews(volunteers.views ?? []);
  if (!args.apply) {
    const list = (titles, none) => titles.map((t) => `"${t}"`).join(', ') || none;
    log(`dry run: Events board ${args.eventsBoard} needs ${list(onEvents, 'no columns')}`);
    log(`dry run: Volunteers board ${args.board} needs ${list([...toCreate.map((s) => s.title), ...derived], 'no columns')} and ${list(views, 'no views')}`);
    return;
  }

  if (onEvents.includes('Shift Lead')) {
    await createColumn(shiftLeadVariables(args.eventsBoard, args.peopleBoards));
    events = await read(args.eventsBoard);
  }
  if (onEvents.includes('Shift Lead Email')) {
    const emailColumns = [];
    for (const id of args.peopleBoards) emailColumns.push([id, find(await read(id), 'Personal Email', 'email').id]);
    await createColumn(leadEmailVariables(args.eventsBoard, { shiftLeadColumn: find(events, 'Shift Lead', 'board_relation').id, emailColumns }));
    events = await read(args.eventsBoard);
  }
  for (const spec of toCreate) await createColumn(createColumnVariables(args.board, spec, args.eventsBoard));
  if (toCreate.length > 0) volunteers = await read(args.board);

  for (const title of derived) {
    // Re-read each time: the formula names the Event Date mirror made just before it.
    const eventDate = volunteers.columns.find((c) => bareTitle(c.title) === 'Event Date' && c.type === 'mirror');
    if (title === 'Event and Date' && !eventDate) throw new Error('setup-volunteers-board: the board has no Event Date mirror for the heading');
    await createColumn(derivedColumnVariables(title, {
      board: args.board,
      eventsBoard: args.eventsBoard,
      eventColumn: find(volunteers, 'Event', 'board_relation').id,
      eventsDateColumn: find(events, 'Date', 'date').id,
      shiftLeadColumn: find(events, 'Shift Lead', 'board_relation').id,
      leadEmailColumn: find(events, 'Shift Lead Email', 'mirror').id,
      eventDateColumn: eventDate?.id,
    }));
    volunteers = await read(args.board);
  }

  if (views.includes(VIEW_NAME)) {
    await graphql(CREATE_VIEW, recentEventsViewVariables(args.board, { dateColumn: find(volunteers, 'Date', 'date').id }));
    log(`created view "${VIEW_NAME}"`);
  }
  if (views.includes(UPCOMING_VIEW_NAME)) {
    const status = find(volunteers, 'Status', 'status');
    const ticketType = find(volunteers, 'Ticket Type', 'text');
    const shown = [
      'name', ticketType.id, find(volunteers, 'Attendee Email', 'email').id, find(volunteers, 'Attendee Phone', 'text').id, status.id,
      find(volunteers, 'Shift Lead', 'mirror').id, find(volunteers, 'Shift Lead Email', 'mirror').id,
    ];
    await graphql(CREATE_VIEW, upcomingViewVariables(args.board, {
      filterDateColumn: find(volunteers, 'Date', 'date').id,
      statusColumn: status.id,
      canceledId: canceledLabelId(status.settings_str),
      headingColumn: find(volunteers, 'Event and Date', 'formula').id,
      ticketTypeColumn: ticketType.id,
      columnOrder: shown,
      hidden: volunteers.columns.map((c) => c.id).filter((id) => !shown.includes(id)),
    }));
    log(`created view "${UPCOMING_VIEW_NAME}"`);
  }
  console.log(JSON.stringify({ volunteers: columnConfig(volunteers.columns) }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
