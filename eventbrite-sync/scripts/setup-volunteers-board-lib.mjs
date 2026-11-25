// Pure planning for setup-volunteers-board.mjs: which Volunteers columns are missing, the request
// that creates each, the Shift Lead link on Events, and the two views. No I/O here, so it is testable without Monday.

import { bareTitle } from '../../scripts/lib/column-titles.mjs';

export const VIEW_NAME = 'Recent events';
export const UPCOMING_VIEW_NAME = 'Upcoming by event';
export const RECENT_DAYS = 90;

// `key` is the key in config attendeeSync.volunteers. `relation` columns point at the Events board.
// Event is the staff-editable one (marked neither 🔒 nor 📜); the rest are written by the Worker.
export const VOLUNTEER_COLUMN_SPECS = [
  { key: 'eventColumn', title: 'Event', type: 'board_relation', relation: true },
  { key: 'listingColumn', title: 'Eventbrite Listing', type: 'board_relation', relation: true },
  { key: 'attendeeIdColumn', title: 'Eventbrite Attendee ID', type: 'text' },
  { key: 'attendeeNameColumn', title: 'Attendee Name', type: 'text' },
  { key: 'attendeeEmailColumn', title: 'Attendee Email', type: 'email' },
  // Shift and Phone Number are staff's names (2026-11-24), formerly Ticket Type and Attendee Phone. The
  // script matches by title, so a rename in Monday needs one here too or the next run duplicates it.
  // GL#115. Text, not status: ticket class names are free text, per event.
  { key: 'ticketTypeColumn', title: 'Shift', type: 'text' },
  // Text, as entered: Monday's phone column refuses what it can't parse.
  { key: 'attendeePhoneColumn', title: 'Phone Number', type: 'text' },
  // When the listing runs: two same-named listings on one date are two shifts of an event (#5).
  { key: 'shiftTimeColumn', title: 'Shift Time', type: 'text' },
];

// Columns Monday works out from the linked event, in the order they must be created. No Worker
// writes them and no config holds their ids.
const SHIFT_LEAD = 'Shift Lead';
const SHIFT_LEAD_EMAIL = 'Shift Lead Email';
export const SEND_LINK = 'Send event email';
const DERIVED_TITLES = ['Event Date', SHIFT_LEAD, SHIFT_LEAD_EMAIL, 'Event and Date', SEND_LINK];
const EVENTS_TITLES = [SHIFT_LEAD, SHIFT_LEAD_EMAIL];

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

export function planViews(existingViews) {
  const names = new Set(existingViews.map((v) => v.name));
  return [VIEW_NAME, UPCOMING_VIEW_NAME].filter((name) => !names.has(name));
}

const missingTitles = (wanted, columns) => {
  const titles = new Set(columns.map((c) => bareTitle(c.title)));
  return wanted.filter((title) => !titles.has(title));
};

export function planEventsColumns(eventsColumns) {
  return missingTitles(EVENTS_TITLES, eventsColumns);
}

// One-way: a two-way link would add a column to People, and then People (Historical) needs it too.
export function shiftLeadVariables(eventsBoardId, peopleBoardIds) {
  return {
    board: eventsBoardId,
    title: SHIFT_LEAD,
    type: 'board_relation',
    defaults: JSON.stringify({ boardIds: peopleBoardIds.map(Number), allowMultipleItems: false, allowCreateReflectionColumn: false }),
    description: "Who leads the volunteers at this event. Shown on the Volunteers board's Upcoming by event view.",
  };
}

const mirrorSettings = (relationColumn, linked) => ({
  relation_column: { [relationColumn]: true },
  displayed_linked_columns: linked.map(([board_id, columnId]) => ({ board_id, column_ids: [columnId] })),
});

/** `emailColumns` is [boardId, columnId] for each People board's Personal Email. */
export function leadEmailVariables(eventsBoardId, { shiftLeadColumn, emailColumns }) {
  return {
    board: eventsBoardId,
    title: SHIFT_LEAD_EMAIL,
    type: 'mirror',
    defaults: JSON.stringify(mirrorSettings(shiftLeadColumn, emailColumns)),
    description: "The shift lead's Personal Email on People.",
  };
}

/** The send link needs its column on Events, which an environment without a send page doesn't have. */
export function planDerivedColumns(volunteersColumns, eventsColumns) {
  const hasSendLink = missingTitles([SEND_LINK], eventsColumns).length === 0;
  return missingTitles(DERIVED_TITLES, volunteersColumns).filter((title) => title !== SEND_LINK || hasSendLink);
}

/**
 * The heading starts with the ISO date because Monday sorts formula groups only A to Z (2026-11-24):
 * that makes A to Z date order. It reads the linked event, so a rename or a re-pointed Event moves the
 * row at once, with nothing to sync (Job would go stale).
 *
 * The send link alone goes through Eventbrite Listing: its page emails the volunteers of the listing
 * it names, while a re-pointed Event is the attendee event, whose page emails the participants.
 */
export function derivedColumnVariables(title, { board, eventsBoard, eventColumn, eventsDateColumn, shiftLeadColumn, leadEmailColumn, eventDateColumn, listingColumn, sendLinkColumn }) {
  const mirrorOf = (columnId, relationColumn = eventColumn) => mirrorSettings(relationColumn, [[eventsBoard, columnId]]);
  const columns = {
    'Event Date': { type: 'mirror', defaults: () => mirrorOf(eventsDateColumn), description: "The linked event's date." },
    [SHIFT_LEAD]: { type: 'mirror', defaults: () => mirrorOf(shiftLeadColumn), description: "The linked event's shift lead; set it on the event." },
    [SHIFT_LEAD_EMAIL]: { type: 'mirror', defaults: () => mirrorOf(leadEmailColumn), description: "The shift lead's email, through the linked event." },
    'Event and Date': {
      type: 'formula',
      defaults: () => ({ formula: `IF({${eventColumn}}="","No event linked",CONCATENATE({${eventDateColumn}}," · ",{${eventColumn}}))` }),
      description: 'Heads each section of the Upcoming by event view.',
    },
    [SEND_LINK]: {
      type: 'mirror',
      defaults: () => mirrorOf(sendLinkColumn, listingColumn),
      description: 'Opens the page that emails everyone signed up for this volunteer listing.',
    },
  };
  const spec = columns[title];
  if (!spec) throw new Error(`setup-volunteers-board: no derived column "${title}"`);
  return { board, title, type: spec.type, defaults: JSON.stringify(spec.defaults()), description: spec.description };
}

/** A status column's `settings_str` keys its labels by id, which is what a view filter compares. */
export function canceledLabelId(statusSettingsStr) {
  const entry = Object.entries(JSON.parse(statusSettingsStr).labels ?? {}).find(([, label]) => label === 'Canceled');
  if (!entry) throw new Error('setup-volunteers-board: the Status column has no Canceled label');
  return Number(entry[0]);
}

/** The columns a new Upcoming by event shows, in order. Throws naming one the board lacks. */
export function upcomingColumnOrder(volunteersColumns) {
  const id = (title, type) => {
    const column = volunteersColumns.find((c) => bareTitle(c.title) === title && c.type === type);
    if (!column) throw new Error(`setup-volunteers-board: the Volunteers board has no ${type} column "${title}"`);
    return column.id;
  };
  const sendLink = volunteersColumns.find((c) => bareTitle(c.title) === SEND_LINK && c.type === 'mirror');
  return [
    'name', ...(sendLink ? [sendLink.id] : []), id('Shift', 'text'), id('Shift Time', 'text'), id('Attendee Email', 'email'), id('Phone Number', 'text'),
    id('Status', 'status'), id(SHIFT_LEAD, 'mirror'), id(SHIFT_LEAD_EMAIL, 'mirror'),
  ];
}

/**
 * Upcoming sign-ups, one section per event: who staff email before it, and the lead's contact list.
 * Either date keeps a row. Date is the listing's, so it misses a change to the event staff re-pointed
 * the row to; Event Date is empty on a row with no event.
 */
export function upcomingViewVariables(boardId, { dateColumn, eventDateColumn, statusColumn, canceledId, headingColumn, ticketTypeColumn, columnOrder, hidden }) {
  return {
    board: boardId,
    name: UPCOMING_VIEW_NAME,
    filter: {
      operator: 'and',
      groups: [
        { operator: 'or', rules: [dateColumn, eventDateColumn].map((column_id) => ({ column_id, operator: 'greater_than_or_equals', compare_value: ['TODAY'] })) },
        { operator: 'and', rules: [{ column_id: statusColumn, operator: 'not_any_of', compare_value: [canceledId] }] },
      ],
    },
    sort: [{ column_id: ticketTypeColumn, direction: 'asc' }],
    settings: {
      group_by: { conditions: [{ columnId: headingColumn, config: { sortSettings: { direction: 'ASC' } } }], hideEmptyGroups: true },
      columns: { column_order: columnOrder, column_properties: hidden.map((column_id) => ({ column_id, visible: false })) },
    },
  };
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
  const out = { board: null, eventsBoard: null, peopleBoards: null, apply: false };
  const flags = { '--board': 'board', '--events-board': 'eventsBoard' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--apply') {
      out.apply = true;
      continue;
    }
    if (flag === '--people-boards') {
      const value = argv[++i];
      // Both People boards: a lead can be on either.
      if (!/^\d+,\d+$/.test(value ?? '')) throw new Error('setup-volunteers-board: --people-boards needs two numeric ids, People and People (Historical), as <id>,<id>');
      out.peopleBoards = value.split(',');
      continue;
    }
    if (!(flag in flags)) throw new Error(`setup-volunteers-board: unknown flag ${flag}`);
    const value = argv[++i];
    if (!/^\d+$/.test(value ?? '')) throw new Error(`setup-volunteers-board: ${flag} needs a numeric id`);
    out[flags[flag]] = value;
  }
  if (out.board === null) throw new Error('setup-volunteers-board: --board <numeric id> is required');
  if (out.eventsBoard === null) throw new Error('setup-volunteers-board: --events-board <numeric id> is required');
  if (out.peopleBoards === null) throw new Error('setup-volunteers-board: --people-boards <id>,<id> is required');
  return out;
}
