import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runReminders } from './reminders';
import type { Config, Member } from './types';

const baseConfig: Config = {
  monday: {
    apiUrl: 'https://api.monday.com/v2',
    donorsBoardId: 999,
    columns: {
      membershipStatus: 'status',
      membershipTier: 'tier',
      memberUntil: 'until',
      remindersSent: 'sent',
      email: 'email',
    },
  },
  stages: [{ tag: '6w', offsetDays: 42 }],
  renewalUrl: 'https://example.org/renew',
  timeZone: 'America/Los_Angeles',
  lifetimeTierValue: 'Lifetime',
  activeStatusValue: 'Active',
};

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: '1',
    name: 'Jamie',
    email: 'jamie@example.org',
    membershipTier: 'Individual',
    memberUntil: '2026-10-01',
    remindersSent: '',
    ...overrides,
  };
}

function makeDeps(members: Member[]) {
  return {
    monday: {
      queryDueMembers: vi.fn().mockResolvedValue(members),
      stampReminderSent: vi.fn().mockResolvedValue(undefined),
    },
    sendEmail: vi.fn().mockResolvedValue(undefined),
  };
}

describe('runReminders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T06:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('throws if donorsBoardId is not configured', async () => {
    const config = { ...baseConfig, monday: { ...baseConfig.monday, donorsBoardId: null } };
    await expect(runReminders(config, makeDeps([]))).rejects.toThrow('donorsBoardId');
  });

  it('sends and stamps an eligible, unstamped member', async () => {
    const deps = makeDeps([member()]);
    const summary = await runReminders(baseConfig, deps);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(deps.monday.stampReminderSent).toHaveBeenCalledWith('1', 999, 'sent', '6w:2026-10-01');
    expect(summary.stages['6w']).toEqual({ sent: 1, skipped: 0, failed: 0 });
  });

  it('skips a Lifetime-tier member without sending', async () => {
    const deps = makeDeps([member({ membershipTier: 'Lifetime' })]);
    const summary = await runReminders(baseConfig, deps);
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(summary.stages['6w']).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it('skips a member already stamped for this term', async () => {
    const deps = makeDeps([member({ remindersSent: '6w:2026-10-01' })]);
    const summary = await runReminders(baseConfig, deps);
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(summary.stages['6w']).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });

  it('counts a member as failed when sending never succeeds, without stamping', async () => {
    const deps = makeDeps([member()]);
    deps.sendEmail.mockRejectedValue(new Error('send failed'));
    // withRetry waits between attempts via real setTimeout; under fake timers that promise
    // never settles unless we flush pending timers while the call is in flight.
    const summaryPromise = runReminders(baseConfig, deps);
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;
    expect(deps.monday.stampReminderSent).not.toHaveBeenCalled();
    expect(summary.stages['6w']).toEqual({ sent: 0, skipped: 0, failed: 1 });
  });

  it('still counts as sent when the send succeeds but stamping never succeeds', async () => {
    const deps = makeDeps([member()]);
    deps.monday.stampReminderSent.mockRejectedValue(new Error('stamp failed'));
    const summaryPromise = runReminders(baseConfig, deps);
    await vi.runAllTimersAsync();
    const summary = await summaryPromise;
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(summary.stages['6w']).toEqual({ sent: 1, skipped: 0, failed: 0 });
  });
});
