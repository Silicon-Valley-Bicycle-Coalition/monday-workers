import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkPledgeCounts, logPledgeCounts } from './check';

const now = new Date('2026-06-01T15:00:00Z');

function deps(endsAt: Record<string, string | null | undefined>) {
  return {
    counter: { countAttendees: vi.fn().mockResolvedValue(10) },
    ledger: { countByEvent: vi.fn().mockResolvedValue(9) },
    events: { getEvent: vi.fn(async (id: string) => (endsAt[id] === undefined ? null : { endsAt: endsAt[id]! })) },
    eventIds: Object.keys(endsAt),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('checkPledgeCounts', () => {
  it('checks an event still ahead', async () => {
    expect(await checkPledgeCounts(now, deps({ '1': '2026-07-01T00:00:00Z' }))).toEqual([{ eventId: '1', eventbrite: 10, ledger: 9 }]);
  });

  it('checks an event with no end date yet', async () => {
    expect(await checkPledgeCounts(now, deps({ '1': null }))).toHaveLength(1);
  });

  it('checks an event with no ledger row yet', async () => {
    const d = deps({});
    d.eventIds = ['1'];
    expect(await checkPledgeCounts(now, d)).toHaveLength(1);
  });

  it('checks one ended 29 days ago', async () => {
    expect(await checkPledgeCounts(now, deps({ '1': '2026-05-03T15:00:00Z' }))).toHaveLength(1);
  });

  it('skips one ended 31 days ago, reading nothing from Eventbrite', async () => {
    const d = deps({ '1': '2026-05-01T15:00:00Z' });
    expect(await checkPledgeCounts(now, d)).toEqual([]);
    expect(d.counter.countAttendees).not.toHaveBeenCalled();
  });
});

describe('logPledgeCounts', () => {
  it('logs equal counts as info only', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logPledgeCounts([{ eventId: '1', eventbrite: 5, ledger: 5 }]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
  });

  it('raises one error for a difference, with what to do', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    logPledgeCounts([{ eventId: '1', eventbrite: 5, ledger: 4 }]);
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0]![0]);
    expect(line).toContain('"1"');
    expect(line).toContain('5');
    expect(line).toContain('4');
    expect(line).toContain('backfill-attendees.mjs');
    expect(line).toContain('may still be in flight');
  });

  it('says nothing with nothing to check', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logPledgeCounts([]);
    expect(log).not.toHaveBeenCalled();
  });
});
