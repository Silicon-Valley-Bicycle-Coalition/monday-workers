// Pure planning for setup-volunteers-board.mjs: which Volunteers columns are missing, the request
// that creates each, and the "Recent events" view. No I/O here, so it is testable without Monday.

import { bareTitle } from '../../scripts/lib/column-titles.mjs';

export const VIEW_NAME = 'Recent events';
export const RECENT_DAYS = 90;

// `key` is the key in config attendeeSync.volunteers. `relation` columns point at the Events board.
// Event is the staff-editable one (marked neither 🔒 nor 📜); the rest are written by the Worker.
export const VOLUNTEER_COLUMN_SPECS = [
  { key: 'eventColumn', title: 'Event', type: 'board_relation', relation: true },
  { key: 'listingColumn', title: 'Eventbrite Listing', type: 'board_relation', relation: true },
  { key: 'attendeeIdColumn', title: 'Eventbrite Attendee ID', type: 'text' },
  { key: 'attendeeNameColumn', title: 'Attendee Name', type: 'text' },
  { key: 'attendeeEmailColumn', title: 'Attendee Email', type: 'email' },
  // #115. Text, not status: ticket class names are free text, per event.
  { key: 'ticketTypeColumn', title: 'Ticket Type', type: 'text' },
];

/** Idempotent through bareTitle, so a 🔒 marker never causes a duplicate column. */
export function planVolunteersBoard(existingColumns) {
  const titles = new Set(existingColumns.map((c) => bareTitle(c.title)));
  return { toCreate: VOLUNTEER_COLUMN_SPECS.filter((spec) => !titles.has(spec.title)) };
}

export function createColumnVariables(boardId, spec, eventsBoardId) {
  return {
    board: boardId,
    title: spec.title,
    type: spec.type,
    defaults: spec.relation ? JSON.stringify({ boardIds: [Number(eventsBoardId)] }) : undefined,
    description: spec.relation && spec.key === 'eventColumn' ? 'The event this volunteer shift was for' : 'Written by eventbrite-sync',
  };
}

export function planView(existingViews) {
  return { create: !existingViews.some((v) => v.name === VIEW_NAME) };
}

/**
 * Variables for the create_view_table mutation. `direction` is the lowercase GraphQL enum name
 * (`desc`); the Monday MCP tool wants uppercase and silently drops lowercase (production's view
 * sat at ASC until 2026-11-17), which is that tool's quirk, not the API's.
 *
 * Deliberately not grouped by Event: Monday orders relation groups its own way, ignoring the item
 * sort, and offers no group sort for them, so the newest event was not first (2026-11-17). The
 * per-event list is the Events board's "Volunteer events" view instead (README).
 */
export function recentEventsViewVariables(boardId, { dateColumn }) {
  return {
    board: boardId,
    name: VIEW_NAME,
    filter: { operator: 'and', rules: [{ column_id: dateColumn, operator: 'within_the_last', compare_value: ['DAYS', RECENT_DAYS] }] },
    sort: [{ column_id: dateColumn, direction: 'desc' }],
  };
}

export function columnConfig(columns) {
  const byTitle = new Map(columns.map((c) => [bareTitle(c.title), c.id]));
  return Object.fromEntries(VOLUNTEER_COLUMN_SPECS.map((spec) => {
    const id = byTitle.get(spec.title);
    if (id === undefined) throw new Error(`setup-volunteers-board: no column "${spec.title}" on the board`);
    return [spec.key, id];
  }));
}

export function parseArgs(argv) {
  const out = { board: null, eventsBoard: null, apply: false };
  const flags = { '--board': 'board', '--events-board': 'eventsBoard' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') {
      out.apply = true;
      continue;
    }
    if (!(flag in flags)) throw new Error(`setup-volunteers-board: unknown flag ${flag}`);
    const value = argv[++i];
    if (!/^\d+$/.test(value ?? '')) throw new Error(`setup-volunteers-board: ${flag} needs a numeric id`);
    out[flags[flag]] = value;
  }
  if (out.board === null) throw new Error('setup-volunteers-board: --board <numeric id> is required');
  if (out.eventsBoard === null) throw new Error('setup-volunteers-board: --events-board <numeric id> is required');
  return out;
}
