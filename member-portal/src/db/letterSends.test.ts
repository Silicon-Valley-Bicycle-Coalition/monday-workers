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

  // Issue GL#31: the send path claims the row (queued → sending) before emailing, so a crash or a
  // failed markSent after a successful send can never lead a redelivery to send again.
  it('claims a queued row exactly once', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-claim', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });

    expect(await store.claimForSending(id, '2026-08-24T10:05:00.000Z')).toBe(true);
    expect(await store.claimForSending(id, '2026-08-24T10:06:00.000Z')).toBe(false);
    expect((await store.getById(id))?.status).toBe('sending');
  });

  it('releases a claim back to queued, and only a claim', async () => {
    const store = new D1LetterSendStore(env.DB);
    const id = await store.createQueued({ donorItemId: 'donor-release', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    await store.claimForSending(id, '2026-08-24T10:05:00.000Z');

    await store.releaseClaim(id);
    expect((await store.getById(id))?.status).toBe('queued');

    await store.claimForSending(id, '2026-08-24T10:07:00.000Z');
    await store.markSent(id, '2026-08-24T10:08:00.000Z');
    await store.releaseClaim(id);
    expect((await store.getById(id))?.status).toBe('sent');
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

  it('lists the donor ids that already have a row for a year, regardless of status', async () => {
    const store = new D1LetterSendStore(env.DB);
    await store.createQueued({ donorItemId: 'donor-7', year: 2026, createdAt: '2027-01-02T10:00:00.000Z' });
    const skippedId = await store.createQueued({ donorItemId: 'donor-8', year: 2026, createdAt: '2027-01-02T10:00:00.000Z' });
    await store.markSkipped(skippedId, '2027-01-02T10:05:00.000Z');
    await store.createQueued({ donorItemId: 'donor-9', year: 2025, createdAt: '2026-01-02T10:00:00.000Z' });

    const donorIds = await store.listDonorItemIdsForYear(2026);
    expect([...donorIds].sort()).toEqual(['donor-7', 'donor-8']);
  });
});
