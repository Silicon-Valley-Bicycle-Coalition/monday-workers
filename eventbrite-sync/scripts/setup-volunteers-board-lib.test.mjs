import { describe, it, expect } from 'vitest';
import { MARKED_COLUMNS } from '../../scripts/mark-read-only-columns.mjs';
import {
  UPCOMING_VIEW_NAME, VIEW_NAME, VOLUNTEER_COLUMN_SPECS, canceledLabelId, columnConfig, createColumnVariables, derivedColumnVariables, parseArgs,
  leadEmailVariables, planDerivedColumns, planEventsColumns, planViews, planVolunteersBoard, recentEventsViewVariables, shiftLeadVariables, upcomingViewVariables,
} from './setup-volunteers-board-lib.mjs';

const col = (id, title, type = 'text') => ({ id, title, type });

describe('planVolunteersBoard', () => {
  it('plans all seven columns on a board that has none of them', () => {
    const { toCreate } = planVolunteersBoard([col('text_1', '📜 Job'), col('date_1', '📜 Date', 'date')]);
    expect(toCreate.map((s) => s.title)).toEqual(['Event', 'Eventbrite Listing', 'Eventbrite Attendee ID', 'Attendee Name', 'Attendee Email', 'Ticket Type', 'Attendee Phone']);
    expect(toCreate.map((s) => s.type)).toEqual(['board_relation', 'board_relation', 'text', 'text', 'email', 'text', 'text']);
  });

  it('plans only Ticket Type on a board set up before #115', () => {
    const before = VOLUNTEER_COLUMN_SPECS.filter((s) => s.key !== 'ticketTypeColumn').map((s, i) => col(`c_${i}`, `🔒 ${s.title}`, s.type));
    expect(planVolunteersBoard(before).toCreate.map((s) => s.key)).toEqual(['ticketTypeColumn']);
  });

  it('does not plan a column that exists under a 🔒 marker', () => {
    const { toCreate } = planVolunteersBoard([col('text_9', '🔒 Eventbrite Attendee ID')]);
    expect(toCreate.map((s) => s.title)).not.toContain('Eventbrite Attendee ID');
    expect(toCreate).toHaveLength(6);
  });

  it('plans nothing on a complete board', () => {
    const all = VOLUNTEER_COLUMN_SPECS.map((s, i) => col(`c_${i}`, s.title, s.type));
    expect(planVolunteersBoard(all).toCreate).toEqual([]);
  });

  it('does not mutate its input', () => {
    const existing = [col('a', 'Event', 'board_relation')];
    planVolunteersBoard(existing);
    expect(existing).toEqual([col('a', 'Event', 'board_relation')]);
  });
});

describe('createColumnVariables', () => {
  it('points a relation column at the Events board', () => {
    const spec = VOLUNTEER_COLUMN_SPECS.find((s) => s.key === 'eventColumn');
    const vars = createColumnVariables('7', spec, '9');
    expect(vars).toMatchObject({ board: '7', title: 'Event', type: 'board_relation' });
    expect(JSON.parse(vars.defaults)).toEqual({ boardIds: [9] });
  });

  it('sets no defaults on a plain column', () => {
    const spec = VOLUNTEER_COLUMN_SPECS.find((s) => s.key === 'attendeeNameColumn');
    expect(createColumnVariables('7', spec, '9').defaults).toBeUndefined();
  });
});

describe('planViews', () => {
  it('creates both views when absent', () => expect(planViews([{ id: '1', name: 'Main Table' }])).toEqual([VIEW_NAME, UPCOMING_VIEW_NAME]));
  it('creates only the missing one', () => expect(planViews([{ id: '1', name: 'Recent events' }])).toEqual(['Upcoming by event']));
  it('creates nothing when both exist', () => expect(planViews([{ name: VIEW_NAME }, { name: UPCOMING_VIEW_NAME }])).toEqual([]));
});

describe('Shift Lead on Events', () => {
  it('is planned when absent and skipped when present, marked or not', () => {
    expect(planEventsColumns([col('b', 'Organizer', 'board_relation')])).toEqual(['Shift Lead', 'Shift Lead Email']);
    expect(planEventsColumns([col('b', '🔒 Shift Lead', 'board_relation')])).toEqual(['Shift Lead Email']);
    expect(planEventsColumns([col('b', 'Shift Lead', 'board_relation'), col('m', 'Shift Lead Email', 'mirror')])).toEqual([]);
  });

  it('links one person, one way, on either People board', () => {
    const vars = shiftLeadVariables('9', ['1', '2']);
    expect(vars).toMatchObject({ board: '9', title: 'Shift Lead', type: 'board_relation' });
    expect(JSON.parse(vars.defaults)).toEqual({ boardIds: [1, 2], allowMultipleItems: false, allowCreateReflectionColumn: false });
  });

  it('mirrors the lead’s email from either People board', () => {
    const vars = leadEmailVariables('9', { shiftLeadColumn: 'lead', emailColumns: [['1', 'e1'], ['2', 'e2']] });
    expect(vars).toMatchObject({ board: '9', title: 'Shift Lead Email', type: 'mirror' });
    expect(JSON.parse(vars.defaults)).toEqual({ relation_column: { lead: true }, displayed_linked_columns: [{ board_id: '1', column_ids: ['e1'] }, { board_id: '2', column_ids: ['e2'] }] });
  });
});

describe('derived Volunteers columns', () => {
  const ids = { board: '7', eventsBoard: '9', eventColumn: 'rel', eventsDateColumn: 'd', shiftLeadColumn: 'lead', leadEmailColumn: 'mail', eventDateColumn: 'mir' };

  it('plans the missing ones in dependency order', () => {
    expect(planDerivedColumns([])).toEqual(['Event Date', 'Shift Lead', 'Shift Lead Email', 'Event and Date']);
    expect(planDerivedColumns([col('m', '🔒 Event Date', 'mirror')])).toEqual(['Shift Lead', 'Shift Lead Email', 'Event and Date']);
  });

  it('does not take the 📜 Date column for Event Date', () => {
    expect(planDerivedColumns([col('date_1', '📜 Date', 'date')])).toContain('Event Date');
  });

  it('mirrors the linked event’s date, lead and lead email', () => {
    const date = derivedColumnVariables('Event Date', ids);
    expect(date).toMatchObject({ board: '7', title: 'Event Date', type: 'mirror' });
    expect(JSON.parse(date.defaults)).toEqual({ relation_column: { rel: true }, displayed_linked_columns: [{ board_id: '9', column_ids: ['d'] }] });
    const lead = derivedColumnVariables('Shift Lead', ids);
    expect(lead.type).toBe('mirror');
    expect(JSON.parse(lead.defaults)).toEqual({ relation_column: { rel: true }, displayed_linked_columns: [{ board_id: '9', column_ids: ['lead'] }] });
    const email = derivedColumnVariables('Shift Lead Email', ids);
    expect(JSON.parse(email.defaults)).toEqual({ relation_column: { rel: true }, displayed_linked_columns: [{ board_id: '9', column_ids: ['mail'] }] });
  });

  it('heads a row with its event’s date and name, or says none is linked', () => {
    const vars = derivedColumnVariables('Event and Date', ids);
    expect(vars.type).toBe('formula');
    expect(JSON.parse(vars.defaults).formula).toBe('IF({rel}="","No event linked",CONCATENATE({mir}," · ",{rel}))');
  });

  it('refuses a title it does not know', () => expect(() => derivedColumnVariables('Nope', ids)).toThrow('Nope'));
});

describe('canceledLabelId', () => {
  it('reads the id of the Canceled label', () => expect(canceledLabelId('{"labels":{"3":"Completed","4":"Canceled"}}')).toBe(4));
  it('throws when there is none', () => expect(() => canceledLabelId('{"labels":{"3":"Completed"}}')).toThrow('Canceled'));
});

describe('upcomingViewVariables', () => {
  const v = upcomingViewVariables('7', { filterDateColumn: 'date_d', statusColumn: 's', canceledId: 4, headingColumn: 'f', ticketTypeColumn: 't', columnOrder: ['name', 't'], hidden: ['h'] });

  it('keeps today onward, without Canceled rows', () => {
    expect(v).toMatchObject({ board: '7', name: 'Upcoming by event' });
    expect(v.filter).toEqual({ operator: 'and', rules: [
      { column_id: 'date_d', operator: 'greater_than_or_equals', compare_value: ['TODAY'] },
      { column_id: 's', operator: 'not_any_of', compare_value: [4] }] });
  });

  it('groups by the heading A to Z, which is date order, and sorts by shift inside', () => {
    expect(v.settings.group_by).toEqual({ conditions: [{ columnId: 'f', config: { sortSettings: { direction: 'ASC' } } }], hideEmptyGroups: true });
    expect(v.sort).toEqual([{ column_id: 't', direction: 'asc' }]);
  });

  it('shows the contact columns and hides the rest', () => {
    expect(v.settings.columns).toEqual({ column_order: ['name', 't'], column_properties: [{ column_id: 'h', visible: false }] });
  });
});

describe('recentEventsViewVariables', () => {
  const vars = recentEventsViewVariables('7', { dateColumn: 'date_d' });

  it('is not grouped (Monday ignores the sort when ordering relation groups)', () => {
    expect(vars.settings).toBeUndefined();
  });

  it('filters Date to the last 90 days', () => {
    expect(vars.filter).toEqual({ operator: 'and', rules: [{ column_id: 'date_d', operator: 'within_the_last', compare_value: ['DAYS', 90] }] });
  });

  it('sorts Date newest first', () => {
    expect(vars.sort).toEqual([{ column_id: 'date_d', direction: 'desc' }]);
    expect(vars).toMatchObject({ board: '7', name: 'Recent events' });
  });
});

describe('columnConfig', () => {
  it('maps marked titles to config keys', () => {
    const cols = VOLUNTEER_COLUMN_SPECS.map((s, i) => col(`c_${i}`, `🔒 ${s.title}`, s.type));
    expect(columnConfig(cols).eventColumn).toBe('c_0');
    expect(Object.keys(columnConfig(cols)).sort()).toEqual(['attendeeEmailColumn', 'attendeeIdColumn', 'attendeeNameColumn', 'attendeePhoneColumn', 'eventColumn', 'listingColumn', 'ticketTypeColumn']);
  });

  it('names a missing column', () => expect(() => columnConfig([])).toThrow('Event'));
});

describe('parseArgs', () => {
  it('is a dry run by default', () => {
    expect(parseArgs(['--board', '1', '--events-board', '2', '--people-boards', '3,4'])).toEqual({ board: '1', eventsBoard: '2', peopleBoards: ['3', '4'], apply: false });
  });
  it('reads --apply', () => expect(parseArgs(['--board', '1', '--events-board', '2', '--people-boards', '3,4', '--apply']).apply).toBe(true));
  it('requires numeric ids', () => {
    expect(() => parseArgs(['--board', 'x', '--events-board', '2'])).toThrow('--board');
    expect(() => parseArgs(['--board', '1'])).toThrow('--events-board');
    expect(() => parseArgs(['--board', '1', '--events-board', '2'])).toThrow('--people-boards');
    expect(() => parseArgs(['--board', '1', '--events-board', '2', '--people-boards', '3'])).toThrow('--people-boards');
    expect(() => parseArgs(['--board', '1', '--events-board', '2', '--people-boards', '3,x'])).toThrow('--people-boards');
    expect(() => parseArgs(['--board', '1', '--events-board', '2', '--nope'])).toThrow('--nope');
  });
});

describe('read-only markers', () => {
  it('locks the Worker-written Volunteers columns', () => {
    expect(MARKED_COLUMNS['Volunteers'].locked).toEqual(['Eventbrite Listing', 'Eventbrite Attendee ID', 'Attendee Name', 'Attendee Email', 'Ticket Type', 'Attendee Phone']);
  });
  it('leaves Event editable', () => {
    const { locked, history } = MARKED_COLUMNS['Volunteers'];
    expect([...locked, ...history]).not.toContain('Event');
  });
});
