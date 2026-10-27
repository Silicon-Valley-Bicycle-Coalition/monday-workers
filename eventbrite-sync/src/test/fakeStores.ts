import { vi } from 'vitest';
import type { EventStore } from '../db/events';
import type { AttendeeStore } from '../db/attendees';

export function fakeEventStore(overrides: Partial<EventStore> = {}): EventStore {
  return {
    recordDelivery: vi.fn().mockResolvedValue('inserted'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getEvent: vi.fn().mockResolvedValue(null),
    listEndedBetween: vi.fn().mockResolvedValue([]),
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
