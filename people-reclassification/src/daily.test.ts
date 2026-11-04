import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { D1Ledger } from './db/ledger';
import { runDaily } from './daily';
import { deps, type FakeState, HIST, LIVE } from '../test/fakeMonday';

const triggers = () => env.DB.prepare('SELECT trigger FROM runs ORDER BY rowid').all<{ trigger: string }>().then((r) => r.results.map((x) => x.trigger));
// A quarterly pass already ran this month, so 2026-10-09 owes no pass.
const noPassDue = () => new D1Ledger(env.DB).startRun({ runId: 'done', trigger: 'quarterly', dryRun: false, startedAt: '2026-10-01T10:00:00Z' });

describe('runDaily', () => {
  beforeEach(async () => {
    await env.DB.batch([env.DB.prepare('DELETE FROM moves'), env.DB.prepare('DELETE FROM alerts'), env.DB.prepare('DELETE FROM runs'), env.DB.prepare('DELETE FROM pass_lease')]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const promoting = (): FakeState => ({
    live: [], historical: [{ id: 'h1', lastGift: '2010-01-01', promote: 'Promote' }],
    boardOf: { h1: String(HIST) }, moves: [], created: [], writes: [], updates: [],
  });

  it('sweeps before the pass on a day a pass is owed', async () => {
    const s = promoting();
    await runDaily(deps(s), { dryRun: false });
    expect(await triggers()).toEqual(['promote-sweep', 'quarterly']);
    expect(s.moves[0]).toMatchObject({ itemId: 'h1', boardId: LIVE });
  });

  it('sweeps on a day no pass is owed', async () => {
    await noPassDue();
    const s = promoting();
    await runDaily(deps(s), { dryRun: false });
    expect(s.moves[0]).toMatchObject({ itemId: 'h1', boardId: LIVE });
  });

  it('still runs the pass when the sweep throws', async () => {
    const s = promoting();
    const d = deps(s);
    d.monday.findItemsByStatus = async () => { throw new Error('down'); };
    await runDaily(d, { dryRun: false });
    expect(await triggers()).toEqual(['quarterly']);
  });
});
