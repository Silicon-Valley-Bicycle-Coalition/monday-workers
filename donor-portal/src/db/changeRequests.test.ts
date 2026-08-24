import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1ChangeRequestStore } from './changeRequests';

function newRequest(overrides: Partial<Parameters<D1ChangeRequestStore['createRequest']>[0]> = {}) {
  return {
    donorItemId: 'donor-1',
    donorName: 'Jane Example',
    field: 'address' as const,
    oldValue: '1 Old St',
    newValue: '2 New Ave',
    dedupeHash: 'hash-a',
    createdAt: '2026-08-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('D1ChangeRequestStore', () => {
  it('creates a request and reads it back as queued', async () => {
    const store = new D1ChangeRequestStore(env.DB);
    const id = await store.createRequest(newRequest());
    const row = await store.getRequest(id);
    expect(row).toEqual({
      id,
      donorItemId: 'donor-1',
      donorName: 'Jane Example',
      field: 'address',
      oldValue: '1 Old St',
      newValue: '2 New Ave',
      status: 'queued',
    });
  });

  it('returns null for an unknown id', async () => {
    const store = new D1ChangeRequestStore(env.DB);
    expect(await store.getRequest(999_999)).toBeNull();
  });

  it('finds a duplicate inside the window and not outside it', async () => {
    const store = new D1ChangeRequestStore(env.DB);
    await store.createRequest(newRequest({ dedupeHash: 'hash-window', createdAt: '2026-08-24T10:00:00.000Z' }));
    expect(await store.hasRecentDuplicate('hash-window', '2026-08-24T00:00:00.000Z')).toBe(true);
    expect(await store.hasRecentDuplicate('hash-window', '2026-08-25T00:00:00.000Z')).toBe(false);
    expect(await store.hasRecentDuplicate('other-hash', '2026-08-24T00:00:00.000Z')).toBe(false);
  });

  it('marks a request written', async () => {
    const store = new D1ChangeRequestStore(env.DB);
    const id = await store.createRequest(newRequest({ dedupeHash: 'hash-written' }));
    await store.markWritten(id, '2026-08-24T11:00:00.000Z');
    expect((await store.getRequest(id))!.status).toBe('written');
  });
});
