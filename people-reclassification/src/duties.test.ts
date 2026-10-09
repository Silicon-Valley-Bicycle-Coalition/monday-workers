import { describe, it, expect } from 'vitest';
import { decideCron } from './duties';
import { validateConfig } from './config';
import sandbox from '../config/sandbox.json';
import type { RunRow } from './db/ledger';

const config = validateConfig(sandbox);

function run(over: Partial<RunRow> = {}): RunRow {
  return { runId: 'r', trigger: 'quarterly', dryRun: false, startedAt: '2026-10-01T10:00:00Z', finishedAt: '2026-10-01T10:01:00Z', status: 'ok', summary: { remaining: 0 }, ...over };
}

const base = { liveItemsCount: 7000, liveItemsLimit: 10000, config };

describe('decideCron', () => {
  it('owes a quarterly pass on the first of a quarter month', () => {
    expect(decideCron({ ...base, todayISO: '2026-10-01', lastRun: null })).toEqual({ trigger: 'quarterly', runId: '2026-10-01-quarterly' });
    expect(decideCron({ ...base, todayISO: '2026-11-01', lastRun: null })).toBeNull();
  });

  it('catches up a missed quarter day later in the month, once', () => {
    expect(decideCron({ ...base, todayISO: '2026-10-05', lastRun: run({ startedAt: '2026-07-01T10:00:00Z' }) })).toEqual({ trigger: 'quarterly', runId: '2026-10-05-quarterly' });
    expect(decideCron({ ...base, todayISO: '2026-10-05', lastRun: run({ startedAt: '2026-10-01T10:00:00Z' }) })).toBeNull();
    expect(decideCron({ ...base, todayISO: '2026-10-01', lastRun: run({ startedAt: '2026-10-01T10:00:00Z' }) })).toBeNull();
  });

  it('owes a threshold pass when the live board is at the trigger percentage and no pass ran this week', () => {
    expect(decideCron({ ...base, todayISO: '2026-11-15', liveItemsCount: 8500, lastRun: run() })).toEqual({ trigger: 'threshold', runId: '2026-11-15-threshold' });
    expect(decideCron({ ...base, todayISO: '2026-11-15', liveItemsCount: 8499, lastRun: run() })).toBeNull();
    expect(decideCron({ ...base, todayISO: '2026-11-15', liveItemsCount: 9000, lastRun: run({ startedAt: '2026-11-10T10:00:00Z' }) })).toBeNull();
  });

  it('continues a live pass that reported remaining work, on a later day only', () => {
    const partial = run({ startedAt: '2026-11-14T10:00:00Z', summary: { remaining: 12 } });
    expect(decideCron({ ...base, todayISO: '2026-11-15', lastRun: partial })).toEqual({ trigger: 'continuation', runId: '2026-11-15-continuation' });
    expect(decideCron({ ...base, todayISO: '2026-11-14', lastRun: partial })).toBeNull();
    expect(decideCron({ ...base, todayISO: '2026-11-15', lastRun: { ...partial, dryRun: true } })).toBeNull();
    expect(decideCron({ ...base, todayISO: '2026-11-15', lastRun: { ...partial, status: 'failed' } })).toBeNull();
  });
});
