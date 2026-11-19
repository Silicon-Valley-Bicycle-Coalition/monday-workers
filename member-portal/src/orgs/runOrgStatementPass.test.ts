import { describe, it, expect, vi } from 'vitest';
import { runOrgStatementPass, type OrgStatementPassDeps } from './runOrgStatementPass';
import { FakeMondayClient } from '../monday/fakeClient';
import type { OrgAffiliation } from '../monday/client';
import type { OrgStatementSendRow, OrgStatementSendStore } from '../db/orgStatementSends';
import type { Config } from '../types';
import type { WriteMode } from '../flags';

// Only the fields the pass reads.
const config = { changeRequests: { employer: { currentStatusLabel: 'Current' } } } as unknown as Config;
const now = () => new Date('2027-01-15T10:00:00.000Z');

function rep(id: string, over: Partial<OrgAffiliation> = {}): OrgAffiliation {
  return { id, personItemId: `p-${id}`, organizationId: 'o1', statusLabel: 'Current', portalAccess: true, workEmail: '', ...over };
}

// In-memory store with the D1 store's contract (UNIQUE key, any-status key listing).
function memoryStore(): OrgStatementSendStore & { rows: OrgStatementSendRow[] } {
  const rows: OrgStatementSendRow[] = [];
  const byId = (id: number) => rows.find((r) => r.id === id);
  const set = (id: number, status: OrgStatementSendRow['status']) => {
    const row = byId(id);
    if (row) row.status = status;
  };
  return {
    rows,
    listKeysForYear: vi.fn(async (year: number) => new Set(rows.filter((r) => r.year === year).map((r) => `${r.orgItemId}:${r.affiliationItemId}`))),
    createQueued: vi.fn(async (p) => {
      if (rows.some((r) => r.orgItemId === p.orgItemId && r.affiliationItemId === p.affiliationItemId && r.year === p.year)) throw new Error('UNIQUE');
      const id = rows.length + 1;
      rows.push({ id, ...p, status: 'queued', sentAt: null });
      return id;
    }),
    findByKey: vi.fn(async (o: string, a: string, y: number) => rows.find((r) => r.orgItemId === o && r.affiliationItemId === a && r.year === y) ?? null),
    getById: vi.fn(async (id: number) => byId(id) ?? null),
    claimForSending: vi.fn(async () => true),
    releaseClaim: vi.fn(async () => {}),
    markSent: vi.fn(async (id: number) => set(id, 'sent')),
    markSkipped: vi.fn(async (id: number) => set(id, 'skipped')),
    requeue: vi.fn(async (id: number) => set(id, 'queued')),
  };
}

function setup(affiliations: OrgAffiliation[], mode: WriteMode = 'on') {
  const monday = new FakeMondayClient();
  for (const a of affiliations) monday.affiliations.set(a.id, a);
  const store = memoryStore();
  const queue = { send: vi.fn().mockResolvedValue(undefined) };
  const deps: OrgStatementPassDeps = { monday, store, queue, config, now, mode };
  return { monday, store, queue, deps };
}

describe('runOrgStatementPass', () => {
  it('queues one row and one message per rep of an organization', async () => {
    const { store, queue, deps } = setup([rep('a1'), rep('a2')]);

    const result = await runOrgStatementPass(deps, 2026, ['o1'], 200);

    expect(result).toEqual({ eligibleReps: 2, alreadyHandled: 0, triggered: 2, failed: 0, deferred: 0 });
    expect(store.rows.map((r) => [r.orgItemId, r.affiliationItemId, r.year])).toEqual([['o1', 'a1', 2026], ['o1', 'a2', 2026]]);
    expect(queue.send.mock.calls.map((c) => c[0])).toEqual([{ sendId: 1, kind: 'org' }, { sendId: 2, kind: 'org' }]);
  });

  it('queues nothing new on a rerun', async () => {
    const { queue, deps } = setup([rep('a1'), rep('a2')]);
    await runOrgStatementPass(deps, 2026, ['o1'], 200);
    queue.send.mockClear();

    const result = await runOrgStatementPass(deps, 2026, ['o1'], 200);

    expect(result).toEqual({ eligibleReps: 2, alreadyHandled: 2, triggered: 0, failed: 0, deferred: 0 });
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('queues only the rep added after the first run', async () => {
    const { monday, store, queue, deps } = setup([rep('a1')]);
    await runOrgStatementPass(deps, 2026, ['o1'], 200);
    monday.affiliations.set('a2', rep('a2'));
    queue.send.mockClear();

    const result = await runOrgStatementPass(deps, 2026, ['o1'], 200);

    expect(result).toMatchObject({ eligibleReps: 2, alreadyHandled: 1, triggered: 1 });
    expect(store.rows.map((r) => r.affiliationItemId)).toEqual(['a1', 'a2']);
    expect(queue.send).toHaveBeenCalledOnce();
  });

  it('skips Former reps, unticked Portal access, and an Affiliation with neither person nor Work Email', async () => {
    const { store, queue, deps } = setup([
      rep('former', { statusLabel: 'Former' }),
      rep('unticked', { portalAccess: false }),
      rep('nobody', { personItemId: null, workEmail: '  ' }),
      rep('work-only', { personItemId: null, workEmail: 'rep@acme.org' }),
    ]);

    const result = await runOrgStatementPass(deps, 2026, ['o1'], 200);

    expect(result).toMatchObject({ eligibleReps: 1, triggered: 1 });
    expect(store.rows.map((r) => r.affiliationItemId)).toEqual(['work-only']);
    expect(queue.send).toHaveBeenCalledOnce();
  });

  it('stops at the budget and defers the rest', async () => {
    const { store, deps } = setup([rep('a1'), rep('a2'), rep('a3')]);

    const result = await runOrgStatementPass(deps, 2026, ['o1'], 1);

    expect(result).toEqual({ eligibleReps: 3, alreadyHandled: 0, triggered: 1, failed: 0, deferred: 2 });
    expect(store.rows).toHaveLength(1);
  });

  it('queues nothing with no budget left', async () => {
    const { store, deps } = setup([rep('a1')]);
    expect(await runOrgStatementPass(deps, 2026, ['o1'], 0)).toMatchObject({ triggered: 0, deferred: 1 });
    expect(store.rows).toHaveLength(0);
  });

  it('counts a failed Affiliations read and goes on to the next organization', async () => {
    const { monday, deps } = setup([rep('a1'), rep('b1', { organizationId: 'o2' })]);
    const real = monday.getOrganizationAffiliations.bind(monday);
    vi.spyOn(monday, 'getOrganizationAffiliations').mockImplementation(async (id) => {
      if (id === 'o1') throw new Error('monday: HTTP 500');
      return real(id);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runOrgStatementPass(deps, 2026, ['o1', 'o2'], 200);

    expect(result).toMatchObject({ eligibleReps: 1, triggered: 1, failed: 1 });
    vi.restoreAllMocks();
  });

  it('re-sends a stranded queued row and requeues a skipped one found at trigger time', async () => {
    const { store, queue, deps } = setup([rep('a1'), rep('a2')]);
    store.rows.push(
      { id: 7, orgItemId: 'o1', affiliationItemId: 'a1', year: 2026, status: 'queued', createdAt: 'x', sentAt: null },
      { id: 8, orgItemId: 'o1', affiliationItemId: 'a2', year: 2026, status: 'skipped', createdAt: 'x', sentAt: 'x' }
    );
    // Rows written after the pre-check (a concurrent run): the pass meets them at trigger time.
    (store.listKeysForYear as ReturnType<typeof vi.fn>).mockResolvedValueOnce(new Set());

    const result = await runOrgStatementPass(deps, 2026, ['o1'], 200);

    expect(queue.send.mock.calls.map((c) => c[0])).toEqual([{ sendId: 7, kind: 'org' }, { sendId: 8, kind: 'org' }]);
    expect(store.requeue).toHaveBeenCalledWith(8, expect.any(String));
    expect(store.requeue).not.toHaveBeenCalledWith(7, expect.any(String));
    expect(store.createQueued).not.toHaveBeenCalled();
    expect(result).toMatchObject({ triggered: 1 });
  });

  it("stamps each message under the write switch's mode, so an off-mode message stays a dry run", async () => {
    const { queue, deps } = setup([rep('a1')], 'off');
    await runOrgStatementPass(deps, 2026, ['o1'], 200);
    expect(queue.send).toHaveBeenCalledWith({ sendId: 1, kind: 'org', writeStamp: 'dropped' });
  });
});
