import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1AttendeeStore } from './attendees';

const T0 = '2026-10-26T00:00:00.000Z';

describe('D1AttendeeStore', () => {
  it('inserts an attendee on first delivery and reads it back', async () => {
    const store = new D1AttendeeStore(env.DB);
    expect(await store.recordDelivery({ attendeeId: 'a-1', eventId: 'E0', action: 'attendee.updated', receivedAt: T0 })).toBe('inserted');
    expect(await store.getAttendee('a-1')).toEqual({
      attendeeId: 'a-1',
      eventId: 'E0',
      mondayItemId: null,
      matchedPersonItemId: null,
      status: 'received',
      lastAction: 'attendee.updated',
      error: null,
      deliveries: 1,
      receivedAt: T0,
      writtenAt: null,
    });
  });

  it('bumps deliveries on a redelivery and keeps the item and person ids', async () => {
    const store = new D1AttendeeStore(env.DB);
    await store.recordDelivery({ attendeeId: 'a-2', eventId: 'E0', action: 'attendee.updated', receivedAt: T0 });
    await store.updateStatus('a-2', 'written', { mondayItemId: 'item-2', matchedPersonItemId: 'person-2', writtenAt: T0 });
    expect(await store.recordDelivery({ attendeeId: 'a-2', eventId: 'E0', action: 'attendee.checked_in', receivedAt: '2026-10-27T00:00:00.000Z' })).toBe('updated');
    const row = await store.getAttendee('a-2');
    expect(row?.status).toBe('received');
    expect(row?.lastAction).toBe('attendee.checked_in');
    expect(row?.deliveries).toBe(2);
    expect(row?.mondayItemId).toBe('item-2');
    expect(row?.matchedPersonItemId).toBe('person-2');
    expect(row?.writtenAt).toBe(T0);
  });

  it('keeps old values when a patch omits them, and clears the error on the next update', async () => {
    const store = new D1AttendeeStore(env.DB);
    await store.recordDelivery({ attendeeId: 'a-3', eventId: 'E0', action: 'attendee.updated', receivedAt: T0 });
    await store.updateStatus('a-3', 'failed', { matchedPersonItemId: 'person-3', error: 'boom' });
    await store.updateStatus('a-3', 'written', { mondayItemId: 'item-3' });
    const row = await store.getAttendee('a-3');
    expect(row?.status).toBe('written');
    expect(row?.matchedPersonItemId).toBe('person-3');
    expect(row?.mondayItemId).toBe('item-3');
    expect(row?.error).toBeNull();
  });

  it('returns null for an unknown attendee', async () => {
    expect(await new D1AttendeeStore(env.DB).getAttendee('nope')).toBeNull();
  });

  it("lists only the given event's attendees", async () => {
    const store = new D1AttendeeStore(env.DB);
    await store.recordDelivery({ attendeeId: 'l-1', eventId: 'E1', action: 'attendee.updated', receivedAt: T0 });
    await store.recordDelivery({ attendeeId: 'l-2', eventId: 'E1', action: 'attendee.updated', receivedAt: T0 });
    await store.recordDelivery({ attendeeId: 'l-3', eventId: 'E2', action: 'attendee.updated', receivedAt: T0 });
    const rows = await store.listByEvent('E1');
    expect(rows.map((r) => r.attendeeId).sort()).toEqual(['l-1', 'l-2']);
    expect(await store.listByEvent('none')).toEqual([]);
  });

  it('lists by received_at, then attendee_id', async () => {
    const store = new D1AttendeeStore(env.DB);
    const later = '2026-10-20T01:00:00.000Z';
    await store.recordDelivery({ attendeeId: 'o-2', eventId: 'E3', action: 'attendee.updated', receivedAt: '2026-10-20T00:00:00.000Z' });
    await store.recordDelivery({ attendeeId: 'o-1', eventId: 'E3', action: 'attendee.updated', receivedAt: later });
    await store.recordDelivery({ attendeeId: 'o-0', eventId: 'E3', action: 'attendee.updated', receivedAt: later });
    expect((await store.listByEvent('E3')).map((r) => r.attendeeId)).toEqual(['o-2', 'o-0', 'o-1']);
  });
});
