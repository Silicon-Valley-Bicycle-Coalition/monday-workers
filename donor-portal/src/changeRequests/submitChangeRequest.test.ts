import { describe, it, expect, vi } from 'vitest';
import { submitChangeRequest, MAX_NEW_VALUE_LENGTH } from './submitChangeRequest';
import type { ChangeRequestStore } from '../db/changeRequests';
import type { MondayClient } from '../monday/client';

function fakeStore(overrides: Partial<ChangeRequestStore> = {}): ChangeRequestStore {
  return {
    createRequest: vi.fn().mockResolvedValue(42),
    hasRecentDuplicate: vi.fn().mockResolvedValue(false),
    getRequest: vi.fn().mockResolvedValue(null),
    markWritten: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMonday(): MondayClient {
  return {
    getDonorContactInfo: vi.fn().mockResolvedValue({
      id: 'donor-1', name: 'Jane Example', email: 'jane@example.org', address: '1 Old St', phone: '555-0100',
    }),
  } as unknown as MondayClient;
}

function makeDeps(store = fakeStore()) {
  return {
    store,
    monday: fakeMonday(),
    queue: { send: vi.fn().mockResolvedValue(undefined) },
    dedupeWindowHours: 72,
    now: () => new Date('2026-08-24T10:00:00.000Z'),
  };
}

describe('submitChangeRequest', () => {
  it('records the request with the current Monday value as old_value and enqueues it', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: ' 2 New Ave ' }, deps);

    expect(result).toEqual({ kind: 'submitted' });
    expect(store.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        donorItemId: 'donor-1',
        donorName: 'Jane Example',
        field: 'address',
        oldValue: '1 Old St',
        newValue: '2 New Ave', // trimmed
        createdAt: '2026-08-24T10:00:00.000Z',
      })
    );
    expect(deps.queue.send).toHaveBeenCalledWith({ requestId: 42 });
  });

  it('rejects a donor item id outside the session', async () => {
    const deps = makeDeps();
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'other', field: 'address', newValue: 'x' }, deps);
    expect(result.kind).toBe('invalid');
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('rejects an unknown field', async () => {
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'ssn', newValue: 'x' }, makeDeps());
    expect(result.kind).toBe('invalid');
  });

  it('rejects an empty and an oversized new value', async () => {
    const deps = makeDeps();
    expect((await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'phone', newValue: '   ' }, deps)).kind).toBe('invalid');
    const oversized = 'x'.repeat(MAX_NEW_VALUE_LENGTH + 1);
    expect((await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'phone', newValue: oversized }, deps)).kind).toBe('invalid');
  });

  it('reports a duplicate inside the dedupe window without inserting or enqueueing', async () => {
    const store = fakeStore({ hasRecentDuplicate: vi.fn().mockResolvedValue(true) });
    const deps = makeDeps(store);
    const result = await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }, deps);
    expect(result).toEqual({ kind: 'duplicate' });
    expect(store.createRequest).not.toHaveBeenCalled();
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('computes the dedupe window from config hours', async () => {
    const store = fakeStore();
    const deps = makeDeps(store);
    await submitChangeRequest(['donor-1'], { donorItemId: 'donor-1', field: 'address', newValue: '2 New Ave' }, deps);
    const sinceISO = (store.hasRecentDuplicate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(sinceISO).toBe('2026-08-21T10:00:00.000Z'); // now − 72h
  });
});
