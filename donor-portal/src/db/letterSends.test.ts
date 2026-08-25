import { env } from 'cloudflare:workers';
import { describe, it, expect } from 'vitest';
import { D1LetterSendStore } from './letterSends';

describe('D1LetterSendStore', () => {
  it('creates a queued row and reads it back by id', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-1', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    const row = await store.getById(id);
    expect(row).toEqual({
      id,
      donorItemId: 'donor-1',
      year: 2025,
      status: 'queued',
      createdAt: '2026-08-24T10:00:00.000Z',
      sentAt: null,
    });
  });

  it('returns null for an unknown id', async () => {
    const store = new D1LetterSendStore(env.DB);
    expect(await store.getById(999_999)).toBeNull();
  });

  it('finds an existing row by donor and year', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-2', year: 2024, createdAt: '2026-08-24T10:00:00.000Z' });
    expect(await store.findByDonorYear('donor-2', 2024)).toEqual({ id, status: 'queued' });
    expect(await store.findByDonorYear('donor-2', 2023)).toBeNull();
    expect(await store.findByDonorYear('other-donor', 2024)).toBeNull();
  });

  it('rejects a second row for the same donor and year', async () => {
    const store = new D1LetterSendStore(env.DB);
    await store.createQueued({ donorItemId: 'donor-3', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    await expect(
      store.createQueued({ donorItemId: 'donor-3', year: 2025, createdAt: '2026-08-24T10:01:00.000Z' })
    ).rejects.toThrow();
  });

  it('marks a row sent', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-4', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    await store.markSent(id, '2026-08-24T10:05:00.000Z');
    expect(await store.findByDonorYear('donor-4', 2025)).toEqual({ id, status: 'sent' });
    const row = await store.getById(id);
    expect(row?.sentAt).toBe('2026-08-24T10:05:00.000Z');
  });

  it('marks a row skipped', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-5', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    await store.markSkipped(id, '2026-08-24T10:05:00.000Z');
    expect(await store.findByDonorYear('donor-5', 2025)).toEqual({ id, status: 'skipped' });
  });

  it('requeues a skipped row back to queued', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-6', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    await store.markSkipped(id, '2026-08-24T10:05:00.000Z');
    await store.requeue(id, '2026-08-24T10:10:00.000Z');
    expect(await store.findByDonorYear('donor-6', 2025)).toEqual({ id, status: 'queued' });
  });
});
