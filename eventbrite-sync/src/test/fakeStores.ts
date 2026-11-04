import { vi } from 'vitest';
import type { EventStore } from '../db/events';
import type { AttendeeStore } from '../db/attendees';
import type { ClassEmailKind, ClassEmailRow, ClassEmailStore } from '../db/classEmails';

export function fakeEventStore(overrides: Partial<EventStore> = {}): EventStore {
  return {
    recordDelivery: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

export function fakeAttendeeStore(overrides: Partial<AttendeeStore> = {}): AttendeeStore {
  return {
    recordDelivery: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getAttendee: vi.fn().mockResolvedValue(null),
    listByEvent: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// An in-memory ledger that behaves like D1ClassEmailStore: claim returns only the ids it newly
// claimed, resolve never changes a `sent` row, release frees failed rows and old enough claims.
export function fakeClassEmailStore(seed: ClassEmailRow[] = []): ClassEmailStore & { rows: ClassEmailRow[] } {
  const rows: ClassEmailRow[] = [...seed];
  const find = (eventId: string, kind: ClassEmailKind, id: string) => rows.findIndex((r) => r.eventId === eventId && r.kind === kind && r.registrationId === id);
  return {
    rows,
    listByEvent: async (eventId) => rows.filter((r) => r.eventId === eventId).map((r) => ({ ...r })),
    claim: async (eventId, kind, ids, claimedAt) => {
      const claimed: string[] = [];
      for (const id of ids) {
        if (find(eventId, kind, id) !== -1) continue;
        rows.push({ eventId, kind, registrationId: id, status: 'claimed', claimedAt, resolvedAt: null });
        claimed.push(id);
      }
      return claimed;
    },
    resolve: async (eventId, kind, id, status, resolvedAt) => {
      const i = find(eventId, kind, id);
      if (i !== -1 && rows[i]!.status !== 'sent') rows[i] = { ...rows[i]!, status, resolvedAt };
    },
    release: async (eventId, kind, ids, claimedBefore) => {
      const released: string[] = [];
      for (const id of ids) {
        const i = find(eventId, kind, id);
        if (i === -1) continue;
        const r = rows[i]!;
        if (r.status === 'failed' || (r.status === 'claimed' && r.claimedAt <= claimedBefore)) {
          rows.splice(i, 1);
          released.push(id);
        }
      }
      return released;
    },
  };
}
