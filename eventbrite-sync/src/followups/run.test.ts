import { describe, expect, it, vi } from 'vitest';
import type { MondayClient, MondayItemColumns } from '../monday/client';
import { MondayApiError } from '../monday/graphql';
import { fakeAttendeeStore, fakeEventStore } from '../test/fakeStores';
import { testConfig } from '../test/testConfig';
import type { AttendeeRow, EventbriteSyncConfig, EventRow } from '../types';
import { runFollowups } from './run';

// Board ids from testConfig: events 222, event-registrations 333, people-live 42.
const EVENTS = 222;
const REGS = 333;
const PEOPLE = 42;
const NOW = new Date('2026-10-25T15:30:00Z'); // Sun 08:30 PDT

function eventRow(eventId: string, mondayItemId: string, overrides: Partial<EventRow> = {}): EventRow {
  return {
    eventId,
    mondayItemId,
    startsAt: '2026-10-24T23:00:00.000Z',
    endsAt: '2026-10-25T02:00:00.000Z', // Sat 19:00 PDT
    locationKey: null,
    eventbriteStatus: 'completed',
    status: 'written',
    lastAction: 'event.updated',
    error: null,
    deliveries: 1,
    receivedAt: '2026-10-01T00:00:00.000Z',
    writtenAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function attendeeRow(attendeeId: string, eventId: string, mondayItemId: string | null): AttendeeRow {
  return {
    attendeeId,
    eventId,
    mondayItemId,
    matchedPersonItemId: null,
    status: 'written',
    lastAction: 'attendee.updated',
    error: null,
    deliveries: 1,
    receivedAt: '2026-10-01T00:00:00.000Z',
    writtenAt: '2026-10-01T00:00:00.000Z',
  };
}

interface FakeEvent {
  name: string;
  classType: string;
  followups: string;
  state?: string;
}
interface FakeReg {
  name: string;
  attendance: string;
  email: string;
  link?: string;
  followup?: string;
  state?: string;
}

// An in-memory Monday holding Events and Event Registrations items, keyed by item id.
function fakeMonday(events: Record<string, FakeEvent>, regs: Record<string, FakeReg>, overrides: Partial<MondayClient> = {}) {
  const config = testConfig();
  const ev = config.attendeeSync.events;
  const rc = config.attendeeSync.registrations;
  const getItems = vi.fn(async (boardId: number, ids: string[], columnIds: string[]): Promise<MondayItemColumns[]> => {
    const out: MondayItemColumns[] = [];
    for (const id of ids) {
      if (boardId === EVENTS && events[id]) {
        const e = events[id];
        const all: Record<string, string> = { [ev.classTypeColumn]: e.classType, [ev.followupsColumn]: e.followups };
        out.push({ id, name: e.name, state: e.state ?? 'active', columns: Object.fromEntries(columnIds.map((c) => [c, all[c] ?? ''])) });
      } else if (boardId === REGS && regs[id]) {
        const r = regs[id];
        const all: Record<string, string> = {
          [rc.attendanceColumn]: r.attendance,
          [rc.attendeeEmailColumn]: r.email,
          [rc.attendeeLinkColumn]: r.link ?? '',
          [rc.followupEmailColumn]: r.followup ?? '',
        };
        out.push({ id, name: r.name, state: r.state ?? 'active', columns: Object.fromEntries(columnIds.map((c) => [c, all[c] ?? ''])) });
      }
    }
    return out;
  });
  const client: MondayClient = {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: '7777' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems,
    notify: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return client;
}

function deps(
  rows: EventRow[],
  attendees: Record<string, AttendeeRow[]>,
  mondayClient: MondayClient,
  config: EventbriteSyncConfig = testConfig()
) {
  return {
    eventStore: fakeEventStore({ listEndedBetween: vi.fn().mockResolvedValue(rows) }),
    attendeeStore: fakeAttendeeStore({ listByEvent: vi.fn(async (eventId: string) => attendees[eventId] ?? []) }),
    mondayClient,
    config,
  };
}

const cfg = testConfig();
const ev = cfg.attendeeSync.events;
const rc = cfg.attendeeSync.registrations;

describe('runFollowups', () => {
  it('reads the ledger window from now − maxAgeDays to now', async () => {
    const d = deps([], {}, fakeMonday({}, {}));
    await runFollowups(NOW, d);
    expect(d.eventStore.listEndedBetween).toHaveBeenCalledWith('2026-10-22T15:30:00.000Z', '2026-10-25T15:30:00.000Z');
  });

  it('writes each registration (label, Class Type, No Show, People link) then Follow-ups Sent last', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Learn to Ride Oct 24', classType: 'Learn to Ride', followups: '' } },
      {
        '501': { name: 'Pat Rider', attendance: 'Attended', email: 'pat@example.com' },
        '502': { name: 'Lee Rider', attendance: 'Registered', email: 'lee@example.com' },
        '503': { name: 'Sam Rider', attendance: 'Attended', email: 'sam@example.com', link: 'Sam Rider' },
        '504': { name: 'Kim Rider', attendance: 'Canceled', email: 'kim@example.com' },
      }
    );
    vi.mocked(monday.findItemByColumnValue).mockResolvedValue({ id: '8001' });
    const d = deps([eventRow('ev1', '9001')], {
      ev1: [attendeeRow('a1', 'ev1', '501'), attendeeRow('a2', 'ev1', '502'), attendeeRow('a3', 'ev1', '503'), attendeeRow('a4', 'ev1', '504'), attendeeRow('a5', 'ev1', null)],
    }, monday);

    const result = await runFollowups(NOW, d);

    expect(result).toEqual({ sent: ['ev1'], held: [], skipped: [], failed: [] });
    const calls = vi.mocked(monday.changeColumnValues).mock.calls;
    expect(calls).toEqual([
      [REGS, '501', { [rc.followupEmailColumn]: 'Thank-you: Learn to Ride', [rc.classTypeColumn]: 'Learn to Ride', [rc.attendeeLinkColumn]: { item_ids: [8001] } }],
      [REGS, '502', { [rc.followupEmailColumn]: 'Missed-you: Learn to Ride', [rc.classTypeColumn]: 'Learn to Ride', [rc.attendanceColumn]: 'No Show' }],
      [REGS, '503', { [rc.followupEmailColumn]: 'Thank-you: Learn to Ride', [rc.classTypeColumn]: 'Learn to Ride' }],
      [EVENTS, '9001', { [ev.followupsColumn]: 'Sent' }],
    ]);
    // Only the unlinked thank-you looked up People, by its email and item name.
    expect(monday.findItemByColumnValue).toHaveBeenCalledTimes(1);
    expect(monday.findItemByColumnValue).toHaveBeenCalledWith(PEOPLE, cfg.attendeeSync.peopleEmailColumn, 'pat@example.com');
    expect(monday.notify).not.toHaveBeenCalled();
  });

  it('creates a Person named after the registration when none matches', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: '' } },
      { '501': { name: 'Pat Rider', attendance: 'Attended', email: '  pat@example.com ' } }
    );
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501')] }, monday);
    await runFollowups(NOW, d);
    expect(monday.findItemByColumnValue).toHaveBeenCalledWith(PEOPLE, cfg.attendeeSync.peopleEmailColumn, 'pat@example.com');
    expect(monday.createItem).toHaveBeenCalledWith(PEOPLE, 'Pat Rider', { [cfg.attendeeSync.peopleEmailColumn]: { email: 'pat@example.com', text: 'pat@example.com' } });
    expect(vi.mocked(monday.changeColumnValues).mock.calls[0]).toEqual([
      REGS,
      '501',
      { [rc.followupEmailColumn]: 'Thank-you: Commute', [rc.classTypeColumn]: 'Commute', [rc.attendeeLinkColumn]: { item_ids: [7777] } },
    ]);
  });

  it('skips an event whose Follow-ups is already Sent, writing nothing', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: 'Sent' } },
      { '501': { name: 'Pat', attendance: 'Attended', email: 'pat@example.com' } }
    );
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501')] }, monday);
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: ['ev1'], failed: [] });
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
    expect(monday.notify).not.toHaveBeenCalled();
  });

  it('skips an event whose Follow-ups is Held', async () => {
    const monday = fakeMonday({ '9001': { name: 'Class', classType: 'Commute', followups: 'Held' } }, {});
    const d = deps([eventRow('ev1', '9001')], {}, monday);
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: ['ev1'], failed: [] });
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
  });

  it('skips an event with a blank Class Type', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: '  ', followups: '' } },
      { '501': { name: 'Pat', attendance: 'Attended', email: 'pat@example.com' } }
    );
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501')] }, monday);
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: ['ev1'], failed: [] });
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
    expect(d.attendeeStore.listByEvent).not.toHaveBeenCalled();
  });

  it('skips an event whose Monday item is gone', async () => {
    const d = deps([eventRow('ev1', '9001')], {}, fakeMonday({}, {}));
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: ['ev1'], failed: [] });
  });

  it('ignores events that are not due yet or are canceled, without reading Monday', async () => {
    const monday = fakeMonday({}, {});
    const d = deps(
      [eventRow('early', '9001', { endsAt: '2026-10-25T16:00:00.000Z' }), eventRow('gone', '9002', { eventbriteStatus: 'canceled' })],
      {},
      monday
    );
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: [], failed: [] });
    expect(monday.getItems).not.toHaveBeenCalled();
  });

  it('skips a class with no registrations in the ledger: no Held, no notify', async () => {
    const config = testConfig();
    config.attendeeSync.followups.notifyUserId = 555;
    const monday = fakeMonday({ '9001': { name: 'Class', classType: 'Commute', followups: '' } }, {});
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', null)] }, monday, config);
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: ['ev1'], failed: [] });
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
    expect(monday.notify).not.toHaveBeenCalled();
  });

  it('skips a class whose registrations are all gone from Monday: no Held, no notify', async () => {
    const config = testConfig();
    config.attendeeSync.followups.notifyUserId = 555;
    const monday = fakeMonday({ '9001': { name: 'Class', classType: 'Commute', followups: '' } }, {});
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501')] }, monday, config);
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: ['ev1'], failed: [] });
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
    expect(monday.notify).not.toHaveBeenCalled();
  });

  it('holds when nobody is Attended: Follow-ups Held, no registration writes, one notification', async () => {
    const config = testConfig();
    config.attendeeSync.followups.notifyUserId = 555;
    const monday = fakeMonday(
      { '9001': { name: 'Learn to Ride Oct 24', classType: 'Learn to Ride', followups: '' } },
      {
        '501': { name: 'Pat', attendance: 'Registered', email: 'pat@example.com' },
        '502': { name: 'Lee', attendance: 'Registered', email: 'lee@example.com' },
      }
    );
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501'), attendeeRow('a2', 'ev1', '502')] }, monday, config);

    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: ['ev1'], skipped: [], failed: [] });
    expect(vi.mocked(monday.changeColumnValues).mock.calls).toEqual([[EVENTS, '9001', { [ev.followupsColumn]: 'Held' }]]);
    expect(monday.notify).toHaveBeenCalledTimes(1);
    expect(monday.notify).toHaveBeenCalledWith(
      555,
      '9001',
      'Follow-ups held for Learn to Ride Oct 24: nobody was checked in. Fix Attendance and clear Follow-ups to send them.'
    );
  });

  it('holds without notifying when notifyUserId is null', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: '' } },
      { '501': { name: 'Pat', attendance: 'Registered', email: 'pat@example.com' } }
    );
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501')] }, monday);
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: ['ev1'], skipped: [], failed: [] });
    expect(monday.notify).not.toHaveBeenCalled();
  });

  it('keeps going when one event throws: the other is still sent', async () => {
    const monday = fakeMonday(
      {
        '9001': { name: 'Broken', classType: 'Commute', followups: '' },
        '9002': { name: 'Fine', classType: 'Commute', followups: '' },
      },
      {
        '501': { name: 'Pat', attendance: 'Attended', email: 'pat@example.com', link: 'Pat' },
        '601': { name: 'Lee', attendance: 'Attended', email: 'lee@example.com', link: 'Lee' },
      }
    );
    const write = vi.mocked(monday.changeColumnValues);
    write.mockImplementation(async (_board, itemId) => {
      if (itemId === '501') throw new Error('Monday 500');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps(
      [eventRow('ev1', '9001'), eventRow('ev2', '9002')],
      { ev1: [attendeeRow('a1', 'ev1', '501')], ev2: [attendeeRow('b1', 'ev2', '601')] },
      monday
    );

    expect(await runFollowups(NOW, d)).toEqual({ sent: ['ev2'], held: [], skipped: [], failed: ['ev1'] });
    // The failed event never got Follow-ups Sent, so the next hourly run retries it.
    expect(write.mock.calls.some(([board, id]) => board === EVENTS && id === '9001')).toBe(false);
    expect(write).toHaveBeenCalledWith(EVENTS, '9002', { [ev.followupsColumn]: 'Sent' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ev1'));
    error.mockRestore();
  });

  it('fails the event without writing any thank-you when a People match throws', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: '' } },
      {
        '501': { name: 'Pat', attendance: 'Attended', email: 'pat@example.com', link: 'Pat' },
        '502': { name: 'Lee', attendance: 'Attended', email: 'lee@example.com' },
      }
    );
    vi.mocked(monday.findItemByColumnValue).mockRejectedValue(new Error('People lookup failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501'), attendeeRow('a2', 'ev1', '502')] }, monday);

    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: [], failed: ['ev1'] });
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('ev1'));
    error.mockRestore();
  });

  it('on a retry, does not re-send to an address already labelled, and still sets Sent', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: '' } },
      {
        '501': { name: 'Pat', attendance: 'Attended', email: 'pat@example.com', link: 'Pat', followup: 'Thank-you: Commute' },
        '502': { name: 'Kid One', attendance: 'No Show', email: 'fam@example.com', followup: 'Missed-you: Commute' },
        '503': { name: 'Kid Two', attendance: 'Registered', email: 'fam@example.com' },
        '504': { name: 'Lee', attendance: 'Registered', email: 'lee@example.com' },
      }
    );
    const d = deps(
      [eventRow('ev1', '9001')],
      { ev1: ['501', '502', '503', '504'].map((id, i) => attendeeRow(`a${i}`, 'ev1', id)) },
      monday
    );
    expect(await runFollowups(NOW, d)).toEqual({ sent: ['ev1'], held: [], skipped: [], failed: [] });
    expect(vi.mocked(monday.changeColumnValues).mock.calls).toEqual([
      [REGS, '504', { [rc.followupEmailColumn]: 'Missed-you: Commute', [rc.classTypeColumn]: 'Commute', [rc.attendanceColumn]: 'No Show' }],
      [EVENTS, '9001', { [ev.followupsColumn]: 'Sent' }],
    ]);
  });

  it('dedupes a shared family email across registrations read from Monday', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Family Ride', classType: 'Family Ride', followups: '' } },
      {
        '501': { name: 'Kid One', attendance: 'Registered', email: 'Parent@Example.com', link: 'Parent' },
        '502': { name: 'Kid Two', attendance: 'Attended', email: 'parent@example.com', link: 'Parent' },
      }
    );
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501'), attendeeRow('a2', 'ev1', '502')] }, monday);
    await runFollowups(NOW, d);
    expect(vi.mocked(monday.changeColumnValues).mock.calls).toEqual([
      [REGS, '502', { [rc.followupEmailColumn]: 'Thank-you: Family Ride', [rc.classTypeColumn]: 'Family Ride' }],
      [EVENTS, '9001', { [ev.followupsColumn]: 'Sent' }],
    ]);
  });

  it('skips an event whose Events item is archived', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: '', state: 'archived' } },
      { '501': { name: 'Pat', attendance: 'Attended', email: 'pat@example.com', link: 'Pat' } }
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501')] }, monday);
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: ['ev1'], failed: [] });
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops archived and deleted registrations: no label, and they do not count for Held', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: '' } },
      {
        '501': { name: 'Pat', attendance: 'Attended', email: 'pat@example.com', link: 'Pat', state: 'archived' },
        '502': { name: 'Lee', attendance: 'Registered', email: 'lee@example.com', state: 'deleted' },
        '503': { name: 'Sam', attendance: 'Attended', email: 'sam@example.com', link: 'Sam' },
      }
    );
    const d = deps([eventRow('ev1', '9001')], { ev1: ['501', '502', '503'].map((id, i) => attendeeRow(`a${i}`, 'ev1', id)) }, monday);
    expect(await runFollowups(NOW, d)).toEqual({ sent: ['ev1'], held: [], skipped: [], failed: [] });
    expect(vi.mocked(monday.changeColumnValues).mock.calls).toEqual([
      [REGS, '503', { [rc.followupEmailColumn]: 'Thank-you: Commute', [rc.classTypeColumn]: 'Commute' }],
      [EVENTS, '9001', { [ev.followupsColumn]: 'Sent' }],
    ]);
  });

  it('holds when the only Attended registration is archived', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: '' } },
      {
        '501': { name: 'Pat', attendance: 'Attended', email: 'pat@example.com', state: 'archived' },
        '502': { name: 'Lee', attendance: 'Registered', email: 'lee@example.com' },
      }
    );
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501'), attendeeRow('a2', 'ev1', '502')] }, monday);
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: ['ev1'], skipped: [], failed: [] });
  });

  it('skips a class whose only registrations are archived or deleted: no Held, no notify', async () => {
    const config = testConfig();
    config.attendeeSync.followups.notifyUserId = 555;
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: '' } },
      {
        '501': { name: 'Pat', attendance: 'Registered', email: 'pat@example.com', state: 'archived' },
        '502': { name: 'Lee', attendance: 'Attended', email: 'lee@example.com', state: 'deleted' },
      }
    );
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501'), attendeeRow('a2', 'ev1', '502')] }, monday, config);
    expect(await runFollowups(NOW, d)).toEqual({ sent: [], held: [], skipped: ['ev1'], failed: [] });
    expect(monday.changeColumnValues).not.toHaveBeenCalled();
    expect(monday.notify).not.toHaveBeenCalled();
  });

  it('logs and skips a registration Monday says is gone on write, and still sends the rest', async () => {
    const monday = fakeMonday(
      { '9001': { name: 'Class', classType: 'Commute', followups: '' } },
      {
        '501': { name: 'Pat', attendance: 'Attended', email: 'pat@example.com', link: 'Pat' },
        '502': { name: 'Lee', attendance: 'Attended', email: 'lee@example.com', link: 'Lee' },
      }
    );
    const write = vi.mocked(monday.changeColumnValues);
    write.mockImplementation(async (_board, itemId) => {
      if (itemId === '501') throw new MondayApiError('Item not found', { code: 'ItemNotFoundException' });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps([eventRow('ev1', '9001')], { ev1: [attendeeRow('a1', 'ev1', '501'), attendeeRow('a2', 'ev1', '502')] }, monday);

    expect(await runFollowups(NOW, d)).toEqual({ sent: ['ev1'], held: [], skipped: [], failed: [] });
    expect(write).toHaveBeenCalledWith(REGS, '502', expect.anything());
    expect(write).toHaveBeenLastCalledWith(EVENTS, '9001', { [ev.followupsColumn]: 'Sent' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('501'));
    warn.mockRestore();
  });
});
