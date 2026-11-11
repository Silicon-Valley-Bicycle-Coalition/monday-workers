import { describe, it, expect, vi } from 'vitest';
import { processAttendee } from './processAttendee';
import { processVolunteer } from './processVolunteer';
import { PLACEHOLDER_COLUMN_ID } from '../config';
import { fakeEventStore, fakeAttendeeStore } from '../test/fakeStores';
import { testConfig } from '../test/testConfig';
import { MondayApiError } from '../monday/graphql';
import { mondayItem } from '../test/mondayItem';
import type { ProcessBatchDeps } from './processBatch';
import type { EventbriteAttendee, EventbriteEvent } from '../eventbrite/client';
import type { MondayClient } from '../monday/client';
import type { AttendeeRow, EventRow } from '../types';

const config = testConfig();

function event(): EventbriteEvent {
  return {
    id: '9001', name: { text: 'Summit Volunteer Shift' }, start: { utc: '2026-10-31T17:00:00Z' }, end: { utc: '2026-10-31T19:00:00Z' },
    status: 'live', organizer_id: 'org-volunteering', organizer: { name: 'Silicon Valley Bicycle Coalition (volunteering)' }, online_event: false,
    venue: { name: 'Mitchell Park', address: { localized_address_display: '600 E Meadow Dr, Palo Alto, CA' } },
  };
}

function attendee(overrides: Partial<EventbriteAttendee> = {}): EventbriteAttendee {
  return { id: 'a1', event_id: '9001', checked_in: false, cancelled: false, refunded: false, profile: { name: 'Pat Rider', first_name: 'Pat', email: 'pat@example.com' }, ...overrides };
}

function eventRow(): EventRow {
  return {
    eventId: '9001', mondayItemId: '5551', startsAt: null, endsAt: null, locationKey: null, eventbriteStatus: null, status: 'written',
    lastAction: 'event.updated', error: null, deliveries: 1, receivedAt: '2026-10-20T00:00:00.000Z', writtenAt: null,
  };
}

function attendeeRow(overrides: Partial<AttendeeRow> = {}): AttendeeRow {
  return {
    attendeeId: 'a1', eventId: '9001', mondayItemId: null, matchedPersonItemId: null, status: 'received', lastAction: 'attendee.updated',
    error: null, deliveries: 1, receivedAt: '2026-10-20T00:00:00.000Z', writtenAt: null, ...overrides,
  };
}

function fakeMonday(overrides: Partial<MondayClient> = {}): MondayClient {
  return {
    findItemByColumnValue: vi.fn().mockResolvedValue(null),
    createItem: vi.fn().mockResolvedValue({ id: 'vol-1' }),
    changeColumnValues: vi.fn().mockResolvedValue(undefined),
    getItems: vi.fn().mockResolvedValue([]),
    postUpdate: vi.fn(), createTimelineItem: vi.fn(),
    ...overrides,
  };
}

function setup(opts: { att?: EventbriteAttendee; row?: AttendeeRow; monday?: Partial<MondayClient>; config?: ReturnType<typeof testConfig> } = {}) {
  const eventStore = fakeEventStore({ getEvent: vi.fn().mockResolvedValue(eventRow()) });
  const attendeeStore = fakeAttendeeStore({ getAttendee: vi.fn().mockResolvedValue(opts.row ?? attendeeRow()) });
  const mondayClient = fakeMonday(opts.monday);
  const eventbriteClient = { getOrder: vi.fn(), getEvent: vi.fn().mockResolvedValue(event()), getAttendee: vi.fn().mockResolvedValue(opts.att ?? attendee()) };
  const deps = { eventStore, attendeeStore, queue: { send: vi.fn() }, mondayClient, eventbriteClient, config: opts.config ?? config } as unknown as ProcessBatchDeps;
  return { deps, attendeeStore, mondayClient };
}

const message = { kind: 'attendee' as const, eventId: '9001', attendeeId: 'a1', action: 'attendee.updated' };
const existing = { row: attendeeRow({ mondayItemId: 'vol-9' }) };
const volItem = (cols: Record<string, string>, opts = {}) => mondayItem('vol-9', 'Pat', cols, opts);

describe('processAttendee on a volunteer event', () => {
  it('creates one Volunteers item with Event and Eventbrite Listing set to the listing, status RSVP', async () => {
    const { deps, mondayClient, attendeeStore } = setup();
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(666, 'vol_att_col', 'a1');
    expect(mondayClient.createItem).toHaveBeenCalledTimes(1);
    const [board, name, values] = (mondayClient.createItem as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(board).toBe(666);
    expect(name).toBe('Pat Rider');
    expect(values).toMatchObject({
      vol_att_col: 'a1', vol_status_col: 'RSVP', vol_job_col: 'Summit Volunteer Shift', vol_hist_col: { checked: 'false' },
      vol_event_col: { item_ids: [5551] }, vol_listing_col: { item_ids: [5551] },
    });
    expect(values.vol_person_col).toBeUndefined();
    expect(mondayClient.createItem).not.toHaveBeenCalledWith(333, expect.anything(), expect.anything());
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ mondayItemId: 'vol-1' }));
  });

  it('adopts an existing item by attendee id and updates it without Event or Historical', async () => {
    const { deps, mondayClient, attendeeStore } = setup({
      monday: {
        findItemByColumnValue: vi.fn().mockResolvedValue({ id: 'vol-9' }),
        getItems: vi.fn().mockResolvedValue([volItem({ vol_status_col: 'RSVP', vol_person_col: '', vol_event_col: 'Some other event' })]),
      },
    });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    const [board, itemId, values] = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect([board, itemId]).toEqual([666, 'vol-9']);
    expect(values).not.toHaveProperty('vol_event_col');
    expect(values).not.toHaveProperty('vol_hist_col');
    expect(values).toMatchObject({ vol_listing_col: { item_ids: [5551] }, vol_status_col: 'RSVP' });
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'written', expect.objectContaining({ mondayItemId: 'vol-9' }));
  });

  it('a check-in writes Completed and, with no Volunteer link, matches People and links', async () => {
    const { deps, mondayClient } = setup({
      ...existing,
      att: attendee({ checked_in: true }),
      monday: {
        getItems: vi.fn().mockResolvedValue([volItem({ vol_status_col: 'RSVP', vol_person_col: '' })]),
        findItemByColumnValue: vi.fn().mockImplementation(async (b: number) => (b === 42 ? { id: '777' } : null)),
      },
    });
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(42, 'people_email_col', 'pat@example.com');
    const values = (mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2];
    expect(values).toMatchObject({ vol_status_col: 'Completed', vol_person_col: { item_ids: [777] } });
  });

  it('does not touch an existing Volunteer link', async () => {
    const { deps, mondayClient } = setup({
      ...existing,
      att: attendee({ checked_in: true }),
      monday: { getItems: vi.fn().mockResolvedValue([volItem({ vol_status_col: 'RSVP', vol_person_col: 'Someone' })]) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect((mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2]).not.toHaveProperty('vol_person_col');
  });

  it('keeps a staff No-Show when Eventbrite still says Registered', async () => {
    const { deps, mondayClient } = setup({
      ...existing,
      monday: { getItems: vi.fn().mockResolvedValue([volItem({ vol_status_col: 'No-Show' })]) },
    });
    await processAttendee(message, deps);
    expect((mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({ vol_status_col: 'No-Show' });
  });

  it('a cancellation with no existing item creates nothing and marks the ledger skipped', async () => {
    const { deps, mondayClient, attendeeStore } = setup({ att: attendee({ cancelled: true }) });
    await processAttendee(message, deps);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'skipped', expect.objectContaining({ error: expect.stringContaining('canceled') }));
  });

  it('a cancellation updates an existing item to Canceled', async () => {
    const { deps, mondayClient } = setup({
      ...existing, att: attendee({ cancelled: true }),
      monday: { getItems: vi.fn().mockResolvedValue([volItem({ vol_status_col: 'RSVP' })]) },
    });
    await processAttendee(message, deps);
    expect((mondayClient.changeColumnValues as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({ vol_status_col: 'Canceled' });
  });

  it.each([
    ['null', testConfig({}, { volunteers: null })],
    ['placeholder', (() => { const c = testConfig(); c.attendeeSync.volunteers.attendeeIdColumn = PLACEHOLDER_COLUMN_ID; return c; })()],
  ])('throws before any write when the Volunteers board is not configured (%s) and never falls back to registrations', async (_name, cfg) => {
    const { deps, mondayClient } = setup({ config: cfg });
    await expect(processAttendee(message, deps)).rejects.toThrow(/volunteers/);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
  });

  it('fails the ledger for an archived item and writes nothing', async () => {
    const { deps, mondayClient, attendeeStore } = setup({
      ...existing,
      monday: { getItems: vi.fn().mockResolvedValue([volItem({ vol_status_col: 'RSVP' }, { state: 'archived' })]) },
    });
    await processAttendee(message, deps);
    expect(mondayClient.changeColumnValues).not.toHaveBeenCalled();
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'failed', expect.objectContaining({ error: expect.stringContaining('deleted or archived') }));
  });

  it('fails the ledger when the item turns out deleted at write time', async () => {
    const { deps, attendeeStore } = setup({
      ...existing,
      monday: {
        getItems: vi.fn().mockResolvedValue([volItem({ vol_status_col: 'RSVP' })]),
        changeColumnValues: vi.fn().mockRejectedValue(new MondayApiError('Item not found', { code: 'ItemNotFound' } as never)),
      },
    });
    await processAttendee(message, deps);
    expect(attendeeStore.updateStatus).toHaveBeenLastCalledWith('a1', 'failed', expect.anything());
  });

  it('processVolunteer is exported for direct use', () => {
    expect(typeof processVolunteer).toBe('function');
  });
});
