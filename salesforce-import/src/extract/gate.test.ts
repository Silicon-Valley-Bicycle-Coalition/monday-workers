import { describe, it, expect } from 'vitest';
import { checkSyncErrorGate } from './gate.js';

const execWithCount = (n: number) => async () => ({
  stdout: JSON.stringify({ status: 0, result: { records: [{ attributes: {}, expr0: n }] } }),
});

describe('sync-error gate', () => {
  it('blocks when funraise errors exist', async () => {
    const r = await checkSyncErrorGate('svbc', { exec: execWithCount(157) });
    expect(r).toEqual({ errorCount: 157, blocked: true });
  });
  it('passes at zero errors', async () => {
    const r = await checkSyncErrorGate('svbc', { exec: execWithCount(0) });
    expect(r.blocked).toBe(false);
  });
  it('acknowledge flag unblocks but still reports the count', async () => {
    const r = await checkSyncErrorGate('svbc', { exec: execWithCount(157), acknowledge: true });
    expect(r).toEqual({ errorCount: 157, blocked: false });
  });
});
