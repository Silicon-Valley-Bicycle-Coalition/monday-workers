import { describe, it, expect, vi } from 'vitest';
import { processDeadLetters, type DeadLetterDeps } from './processDeadLetters';
import type { PendingStore } from '../db/pending';
import type { DonationRollupsConfig } from '../types';

// Fix 5 (README "operational findings, 2026-09-17"): the DLQ had no consumer, so the 09-03 and
// 09-09 messages that exhausted their retries expired unseen and their pending rows stayed
// 'queued' forever. Dead messages must leave a mark in D1 and raise one alert per batch.
const config = {
  monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
  fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
  custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: 42,
    annualSummaryBoardId: null, annualSummaryColumns: null },
  donationRollups: { donationBoards: [], receivedStatusLabel: 'Received', ownerColumnsByBoard: {}, membership: null },
} as unknown as DonationRollupsConfig;

const QUOTA = new Error("D1_ERROR: Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.");

function fakePendingStore(over: Partial<PendingStore> = {}): PendingStore {
  return {
    upsertPending: vi.fn().mockResolvedValue(undefined),
    pruneFinished: vi.fn().mockResolvedValue(0),
    listStuck: vi.fn().mockResolvedValue([]),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    getPending: vi.fn().mockImplementation(async (id: string) => ({
      donationItemId: id, donationBoardId: '1', eventId: 'e', status: 'failed', ownerItemId: null, ownerBoard: null,
      error: 'monday API: HTTP 500', receivedAt: '2026-09-03T19:20:00Z', writtenAt: null,
    })),
    ...over,
  };
}
const message = (id: string, timestamp?: Date) => ({ body: { donationItemId: id, donationBoardId: '1' }, ack: vi.fn(), retry: vi.fn(), timestamp });
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

  it('when D1 itself is over quota, defers the message to midnight UTC instead of acking; other D1 errors retry after a backoff', async () => {
    const quota = deps({ pendingStore: fakePendingStore({ updateStatus: vi.fn().mockRejectedValue(QUOTA) }) });
    const m1 = message('dn1');
    await processDeadLetters([m1], quota);
    expect(m1.retry).toHaveBeenCalledWith({ delaySeconds: 3 * 3600 + 51 * 60 });
    expect(m1.ack).not.toHaveBeenCalled();

    const other = deps({ pendingStore: fakePendingStore({ updateStatus: vi.fn().mockRejectedValue(new Error('D1_ERROR: Network connection lost.')) }) });
    const m2 = message('dn2');
    await processDeadLetters([m2], other);
    expect(m2.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(m2.ack).not.toHaveBeenCalled();
  });
});

// Learned the hard way on the first deploy (2026-09-18 20:38 UTC): the DLQ still held messages
// whose rows had since been re-driven and written by hand. Marking those rows failed downgraded
// 300 correct rows and posted 35 alerts before delivery was paused. A dead message is only
// evidence about the row as of the moment it was SENT.
describe('processDeadLetters — stale messages', () => {
  const writtenRow = (writtenAt: string) => ({
    donationItemId: 'dn1', donationBoardId: '1', eventId: 'e', status: 'written' as const, ownerItemId: 'o1', ownerBoard: '2',
    error: null, receivedAt: '2026-09-03T19:20:00Z', writtenAt,
  });

  it('a dead message sent BEFORE the row\'s last successful write is stale: acked, row untouched, no alert', async () => {
    const d = deps({ pendingStore: fakePendingStore({ getPending: vi.fn().mockResolvedValue(writtenRow('2026-09-17T22:15:40Z')) }) });
    const m = message('dn1', new Date('2026-09-17T21:00:00Z'));
    await processDeadLetters([m], d);
    expect(d.pendingStore.updateStatus).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
    expect(d.mondayClient.createUpdate).not.toHaveBeenCalled();
  });

  it('a dead message sent AFTER the row\'s last write still marks it failed — that later attempt really died', async () => {
    const d = deps({ pendingStore: fakePendingStore({ getPending: vi.fn().mockResolvedValue(writtenRow('2026-09-17T21:00:00Z')) }) });
    await processDeadLetters([message('dn1', new Date('2026-09-17T22:00:00Z'))], d);
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'failed', { error: 'dead-lettered after retries: (no recorded error)' });
  });

  it('never downgrades a written row when the message carries no timestamp', async () => {
    const d = deps({ pendingStore: fakePendingStore({ getPending: vi.fn().mockResolvedValue(writtenRow('2026-09-17T21:00:00Z')) }) });
    const m = message('dn1');
    await processDeadLetters([m], d);
    expect(d.pendingStore.updateStatus).not.toHaveBeenCalled();
    expect(m.ack).toHaveBeenCalled();
  });

  it('does not stack the prefix when the row is already dead-lettered', async () => {
    const already = { ...writtenRow('2026-09-17T21:00:00Z'), status: 'failed' as const, error: 'dead-lettered after retries: monday API: HTTP 500' };
    const d = deps({ pendingStore: fakePendingStore({ getPending: vi.fn().mockResolvedValue(already) }) });
    await processDeadLetters([message('dn1', new Date('2026-09-18T20:00:00Z'))], d);
    expect(d.pendingStore.updateStatus).toHaveBeenCalledWith('dn1', 'failed', { error: 'dead-lettered after retries: monday API: HTTP 500' });
  });

  it('the batch alert names only the rows actually marked failed', async () => {
    const rows: Record<string, unknown> = {
      stale: writtenRow('2026-09-17T22:15:40Z'),
      dead: { ...writtenRow('2026-09-17T21:00:00Z'), status: 'failed', error: 'monday API: HTTP 500' },
    };
    const d = deps({ pendingStore: fakePendingStore({ getPending: vi.fn().mockImplementation(async (id: string) => rows[id]) }) });
    await processDeadLetters([message('stale', new Date('2026-09-17T21:30:00Z')), message('dead', new Date('2026-09-17T21:30:00Z'))], d);
    expect(d.mondayClient.createUpdate).toHaveBeenCalledTimes(1);
    const body = (d.mondayClient.createUpdate as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(body).toContain('dead');
    expect(body).not.toContain('stale');
  });
});
