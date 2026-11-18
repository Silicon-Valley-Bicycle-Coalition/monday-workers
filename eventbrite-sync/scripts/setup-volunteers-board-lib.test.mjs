import { describe, it, expect } from 'vitest';
import { MARKED_COLUMNS } from '../../scripts/mark-read-only-columns.mjs';
import {
  VIEW_NAME, VOLUNTEER_COLUMN_SPECS, columnConfig, createColumnVariables, parseArgs, planVolunteersBoard, planView, recentEventsViewVariables,
} from './setup-volunteers-board-lib.mjs';

const col = (id, title, type = 'text') => ({ id, title, type });

describe('planVolunteersBoard', () => {
  it('plans all six columns on a board that has none of them', () => {
    const { toCreate } = planVolunteersBoard([col('text_1', '📜 Job'), col('date_1', '📜 Date', 'date')]);
    expect(toCreate.map((s) => s.title)).toEqual(['Event', 'Eventbrite Listing', 'Eventbrite Attendee ID', 'Attendee Name', 'Attendee Email', 'Ticket Type']);
    expect(toCreate.map((s) => s.type)).toEqual(['board_relation', 'board_relation', 'text', 'text', 'email', 'text']);
  });

  it('plans only Ticket Type on a board set up before #115', () => {
    const before = VOLUNTEER_COLUMN_SPECS.filter((s) => s.key !== 'ticketTypeColumn').map((s, i) => col(`c_${i}`, `🔒 ${s.title}`, s.type));
    expect(planVolunteersBoard(before).toCreate.map((s) => s.key)).toEqual(['ticketTypeColumn']);
  });

  it('does not plan a column that exists under a 🔒 marker', () => {
    const { toCreate } = planVolunteersBoard([col('text_9', '🔒 Eventbrite Attendee ID')]);
    expect(toCreate.map((s) => s.title)).not.toContain('Eventbrite Attendee ID');
    expect(toCreate).toHaveLength(5);
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

describe('planView', () => {
  it('creates the view when absent', () => expect(planView([{ id: '1', name: 'Main Table' }])).toEqual({ create: true }));
  it('skips it when a view of that name exists', () => expect(planView([{ id: '1', name: VIEW_NAME }])).toEqual({ create: false }));
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
    expect(Object.keys(columnConfig(cols)).sort()).toEqual(['attendeeEmailColumn', 'attendeeIdColumn', 'attendeeNameColumn', 'eventColumn', 'listingColumn', 'ticketTypeColumn']);
  });

  it('names a missing column', () => expect(() => columnConfig([])).toThrow('Event'));
});

describe('parseArgs', () => {
  it('is a dry run by default', () => {
    expect(parseArgs(['--board', '1', '--events-board', '2'])).toEqual({ board: '1', eventsBoard: '2', apply: false });
  });
  it('reads --apply', () => expect(parseArgs(['--board', '1', '--events-board', '2', '--apply']).apply).toBe(true));
  it('requires numeric ids', () => {
    expect(() => parseArgs(['--board', 'x', '--events-board', '2'])).toThrow('--board');
    expect(() => parseArgs(['--board', '1'])).toThrow('--events-board');
    expect(() => parseArgs(['--board', '1', '--events-board', '2', '--nope'])).toThrow('--nope');
  });
});

describe('read-only markers', () => {
  it('locks the Worker-written Volunteers columns', () => {
    expect(MARKED_COLUMNS['Volunteers'].locked).toEqual(['Eventbrite Listing', 'Eventbrite Attendee ID', 'Attendee Name', 'Attendee Email', 'Ticket Type']);
  });
  it('leaves Event editable', () => {
    const { locked, history } = MARKED_COLUMNS['Volunteers'];
    expect([...locked, ...history]).not.toContain('Event');
  });
});
