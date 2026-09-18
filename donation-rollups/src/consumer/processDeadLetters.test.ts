import { describe, it, expect, vi } from 'vitest';
import { processDeadLetters, type DeadLetterDeps } from './processDeadLetters';
import type { PendingStore } from '../db/pending';
import type { DonationRollupsConfig } from '../types';

// Fix 5 (README "operational findings, 2026-09-17"): the DLQ had no consumer, so the 09-03 and
// 09-09 messages that exhausted their retries expired unseen and their pending rows stayed
// 'queued' forever. Dead messages must leave a mark in D1 and raise one alert per batch.
const config = {
  monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
  custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: 42,
    annualSummaryBoardId: null, annualSummaryColumns: null },
  donationRollups: { donationBoards: [], receivedStatusLabel: 'Received', ownerColumnsByBoard: {}, membership: null },
} as unknown as DonationRollupsConfig;

const QUOTA = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.");

function fakePendingStore(over: Partial<PendingStore> = {}): PendingStore {
  return {
    upsertPending: vi.fn().mockResolvedValue('inserted'),
    listStuck: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockImplementation(async (id: string) => ({
      donationItemId: id, donationBoardId: '1', eventId: 'e', status: 'failed', ownerItemId: null, ownerBoard: null,
      error: 'monday API: HTTP 500', receivedAt: '2026-09-03T19:20:00Z', writtenAt: null,
    })),
    ...over,
  };
}
const message = (id: string) => ({ body: { donationItemId: id, donationBoardId: '1' }, ack: vi.fn(), retry: vi.fn() });
const deps = (over: Partial<DeadLetterDeps> = {}): DeadLetterDeps => ({
  pendingStore: fakePendingStore(), mondayClient: { createUpdate: vi.fn().mockResolvedValue(undefined) }, config,
  now: new Date('2026-09-03T20:09:00Z'), ...over,
});

describe('processDeadLetters', () => {
  it('marks each dead message\'s pending row failed, keeping the last recorded error, and acks', async () => {
    const d = deps();
    const m = message('dn1');
    await processDeadLetters([m], d);
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'failed',
      { error: 'dead-lettered after retries: monday API: HTTP 500' });
    expect(m.ack).toHaveBeenCalled();
  });

  it('says so when no error had been recorded (or the row is missing)', async () => {
    const d = deps({ pendingStore: fakePendingStore({ getPending: vi.fn().mockResolvedValue(null) }) });
    await processDeadLetters([message('dn1')], d);
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'failed',
      { error: 'dead-lettered after retries: (no recorded error)' });
  });

  it('posts ONE alert per batch naming every dead donation, on the custodian alert item', async () => {
    const d = deps();
    await processDeadLetters([message('dn1'), message('dn2')], d);
    expect(d.mondayClient.createUpdate).toHaveBeenCalledTimes(1);
    const [itemId, body] = (d.mondayClient.createUpdate as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(itemId).toBe(42);
    expect(body).toContain('dn1');
    expect(body).toContain('dn2');
  });

  it('skips the Monday alert when no alert item is configured, and a failing alert never blocks the acks', async () => {
    const quiet = deps({ config: { ...config, custodian: { ...config.custodian, alertItemId: null } } });
    const m1 = message('dn1');
    await processDeadLetters([m1], quiet);
    expect(quiet.mondayClient.createUpdate).not.toHaveBeenCalled();
    expect(m1.ack).toHaveBeenCalled();

    const broken = deps({ mondayClient: { createUpdate: vi.fn().mockRejectedValue(new Error('HTTP 500')) } });
    const m2 = message('dn2');
    await processDeadLetters([m2], broken);
    expect(m2.ack).toHaveBeenCalled();
  });

  it('when D1 itself is over quota, defers the message to midnight UTC instead of acking; other D1 errors retry immediately', async () => {
    const quota = deps({ pendingStore: fakePendingStore({ updateStatus: vi.fn().mockRejectedValue(QUOTA) }) });
    const m1 = message('dn1');
    await processDeadLetters([m1], quota);
    expect(m1.retry).toHaveBeenCalledWith({ delaySeconds: 3 * 3600 + 51 * 60 });
    expect(m1.ack).not.toHaveBeenCalled();

    const other = deps({ pendingStore: fakePendingStore({ updateStatus: vi.fn().mockRejectedValue(new Error('D1_ERROR: Network connection lost.')) }) });
    const m2 = message('dn2');
    await processDeadLetters([m2], other);
    expect(m2.retry).toHaveBeenCalledWith();
    expect(m2.ack).not.toHaveBeenCalled();
  });
});
