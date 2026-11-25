import type { TaxLetterConfig } from '../types';
import { describe, it, expect, vi } from 'vitest';
import { triggerLetterSend } from './triggerLetterSend';
import type { LetterSendStore } from '../db/letterSends';
import type { MondayClient } from '../monday/client';

function fakeStore(overrides: Partial<LetterSendStore> = {}): LetterSendStore {
  return {
    findByDonorYear: vi.fn().mockResolvedValue(null),
    createQueued: vi.fn().mockResolvedValue(42),
    getById: vi.fn().mockResolvedValue(null),
    markSent: vi.fn().mockResolvedValue(undefined),
    markSkipped: vi.fn().mockResolvedValue(undefined),
    requeue: vi.fn().mockResolvedValue(undefined),
    listDonorItemIdsForYear: vi.fn().mockResolvedValue(new Set()),
    claimForSending: vi.fn().mockResolvedValue(true),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function fakeMonday(donations: { date: string; amount: string; description: string }[]): MondayClient {
  return {
    getMemberPortalData: vi.fn().mockResolvedValue({
      id: 'donor-1',
      name: 'Jane Example',
      membershipStatus: 'Active',
      membershipTier: 'Champion',
      totalDonated: '$100.00',
      donations,
    }),
  } as unknown as MondayClient;
}

function makeDeps(overrides: { store?: LetterSendStore; monday?: MondayClient } = {}) {
  return {
    store: overrides.store ?? fakeStore(),
    monday: overrides.monday ?? fakeMonday([{ date: '2025-03-01', amount: '$50.00', description: 'Donation' }]),
    taxLetter: { acknowledgedGiftTypes: ['Donation'], excludedGiftTypes: ['Event Ticket'], separateGiftTypes: ['Donor Advised Fund'] } as TaxLetterConfig,
    queue: { send: vi.fn().mockResolvedValue(undefined) },
    now: () => new Date('2026-08-24T10:00:00.000Z'),
  };
}

describe('triggerLetterSend', () => {
  it('has no eligible year when the donor gave only through an excluded Gift Type', async () => {
    const deps = makeDeps({ monday: fakeMonday([{ date: '2025-03-01', amount: '$50.00', description: 'Event Ticket' }]) });
    expect(await triggerLetterSend('donor-1', deps)).toEqual({ kind: 'no-eligible-year' });
  });

  it('rejects an empty donor item id', async () => {
    const deps = makeDeps();
    const result = await triggerLetterSend('', deps);
    expect(result.kind).toBe('invalid');
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('reports no-eligible-year when the donor has no completed-year gifts', async () => {
    const deps = makeDeps({ monday: fakeMonday([]) });
    const result = await triggerLetterSend('donor-1', deps);
    expect(result).toEqual({ kind: 'no-eligible-year' });
  });

  it('creates a queued row and enqueues it for a fresh donor+year', async () => {
    const store = fakeStore();
    const deps = makeDeps({ store });
    const result = await triggerLetterSend('donor-1', deps);

    expect(result).toEqual({ kind: 'queued' });
    expect(store.createQueued).toHaveBeenCalledWith({ donorItemId: 'donor-1', year: 2025, createdAt: '2026-08-24T10:00:00.000Z' });
    expect(deps.queue.send).toHaveBeenCalledWith({ sendId: 42 });
  });

  it('is a silent no-op for a donor+year already sent', async () => {
    const store = fakeStore({ findByDonorYear: vi.fn().mockResolvedValue({ id: 7, status: 'sent' }) });
    const deps = makeDeps({ store });
    const result = await triggerLetterSend('donor-1', deps);

    expect(result).toEqual({ kind: 'duplicate' });
    expect(store.createQueued).not.toHaveBeenCalled();
    expect(store.requeue).not.toHaveBeenCalled();
    expect(deps.queue.send).not.toHaveBeenCalled();
  });

  it('re-sends the queue message for a stranded queued row instead of creating a new one', async () => {
    const store = fakeStore({ findByDonorYear: vi.fn().mockResolvedValue({ id: 7, status: 'queued' }) });
    const deps = makeDeps({ store });
    const result = await triggerLetterSend('donor-1', deps);

    expect(result).toEqual({ kind: 'duplicate' });
    expect(store.createQueued).not.toHaveBeenCalled();
    expect(store.requeue).not.toHaveBeenCalled();
    expect(deps.queue.send).toHaveBeenCalledWith({ sendId: 7 });
  });

  it('requeues and re-sends a previously skipped row instead of leaving it permanently blocked', async () => {
    const store = fakeStore({ findByDonorYear: vi.fn().mockResolvedValue({ id: 7, status: 'skipped' }) });
    const deps = makeDeps({ store });
    const result = await triggerLetterSend('donor-1', deps);

    expect(result).toEqual({ kind: 'queued' });
    expect(store.createQueued).not.toHaveBeenCalled();
    expect(store.requeue).toHaveBeenCalledWith(7, '2026-08-24T10:00:00.000Z');
    expect(deps.queue.send).toHaveBeenCalledWith({ sendId: 7 });
  });
});
