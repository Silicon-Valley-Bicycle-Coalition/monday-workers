import { describe, it, expect } from 'vitest';
import { creditFor, refreshCredits, type DonationCreditItem } from './credits';
import type { CustodianDeps } from '../custodian/custodian';
import type { CreditRow, RollCallCreditsStore } from '../db/rollCallCredits';
import type { RollCallConfig } from '../types';

const EXCLUDED = ['Contracts'];
const item = (over: Partial<DonationCreditItem> = {}): DonationCreditItem => ({
  id: 'g1', fiscalYear: 2026, amountCents: 10_000, status: 'Received', giftType: 'Individual Donation',
  donorItemIds: ['p1'], matchedByItemIds: [], anonymous: false, ...over,
});

describe('creditFor', () => {
  it('skips an excluded gift type, a gift that is not received, and an unparseable fiscal year', () => {
    expect(creditFor(item({ giftType: 'Contracts' }), EXCLUDED)).toBe('skip');
    expect(creditFor(item({ status: 'Pledged' }), EXCLUDED)).toBe('skip');
    expect(creditFor(item({ status: null }), EXCLUDED)).toBe('skip');
    expect(creditFor(item({ fiscalYear: 0 }), EXCLUDED)).toBe('skip');
    expect(creditFor(item({ fiscalYear: NaN }), EXCLUDED)).toBe('skip');
  });
  it('credits a matching gift to its Matched By company, even when anonymous', () => {
    expect(creditFor(item({ giftType: 'Matching Donation', matchedByItemIds: ['o9'] }), EXCLUDED))
      .toEqual({ credit: 'item:o9', unmatchedMatch: false });
    expect(creditFor(item({ giftType: 'Matching Donation', matchedByItemIds: ['o9'], anonymous: true }), EXCLUDED))
      .toEqual({ credit: 'item:o9', unmatchedMatch: false });
  });
  it('credits an anonymous gift to the anonymous row, flag over Donor', () => {
    expect(creditFor(item({ anonymous: true }), EXCLUDED)).toEqual({ credit: 'anonymous', unmatchedMatch: false });
  });
  it('counts a gift with no Donor and no flag as unplaced', () => {
    expect(creditFor(item({ donorItemIds: [] }), EXCLUDED)).toEqual({ credit: 'unplaced', unmatchedMatch: false });
  });
  it('flags a matching gift with no Matched By but a Donor, carrying no credit', () => {
    expect(creditFor(item({ giftType: 'Matching Donation' }), EXCLUDED)).toEqual({ credit: null, unmatchedMatch: true });
  });
  it('leaves an ordinary donor gift to the ledger', () => {
    expect(creditFor(item(), EXCLUDED)).toBe('ledger');
    expect(creditFor(item({ status: 'Received (Historical)' }), EXCLUDED)).toBe('ledger');
  });
});

const CFG = { firstFiscalYear: 2026, excludedGiftTypes: EXCLUDED, donations: { boardId: 7, columns: {} } } as unknown as RollCallConfig;
const NOW = '2026-11-02T00:00:00Z';
const row = (over: Partial<CreditRow> = {}): CreditRow => ({
  giftItemId: 'g1', fiscalYear: 2026, amountCents: 10_000, status: 'Received', giftType: 'Individual Donation',
  credit: 'anonymous', unmatchedMatch: false, archivedAt: null, ...over,
});

function harness(active: DonationCreditItem[], stored: CreditRow[], states: Record<string, 'active' | 'archived' | 'deleted'> = {}) {
  const rows = new Map(stored.map((r) => [r.giftItemId, r]));
  const log = { upserts: [] as CreditRow[], removes: [] as string[], archived: [] as string[], stateAsks: [] as string[][] };
  const rollCallCredits: RollCallCreditsStore = {
    async all(fromFY) { return [...rows.values()].filter((r) => r.fiscalYear >= fromFY); },
    async upsert(rs) { for (const r of rs) { rows.set(r.giftItemId, r); log.upserts.push(r); } return rs.length; },
    async remove(ids) { for (const id of ids) rows.delete(id); log.removes.push(...ids); },
    async markArchived(ids, now) { for (const id of ids) rows.set(id, { ...rows.get(id)!, archivedAt: now }); log.archived.push(...ids); },
  };
  const mondayClient = {
    async pageDonationCredits(_c: unknown, cursor: string | null) {
      return cursor === null ? { cursor: 'next', items: active.slice(0, 1) } : { cursor: null, items: active.slice(1) };
    },
    async getItemsState(ids: string[]) {
      log.stateAsks.push(ids);
      return new Map(ids.filter((id) => states[id] !== undefined).map((id) => [id, states[id]!] as const));
    },
  };
  return { deps: { rollCallCredits, mondayClient } as unknown as CustodianDeps, rows, log };
}

describe('refreshCredits', () => {
  it('upserts an active anonymous gift across pages', async () => {
    const h = harness([item({ id: 'a', anonymous: true }), item({ id: 'b', anonymous: true })], []);
    expect(await refreshCredits(h.deps, CFG, NOW)).toEqual({ upserted: 2, removed: 0, archived: 0 });
    expect(h.rows.get('a')).toEqual(row({ giftItemId: 'a' }));
  });
  it('writes nothing for a gift the ledger credits or one before the first fiscal year', async () => {
    const h = harness([item({ id: 'a' }), item({ id: 'old', fiscalYear: 2025, anonymous: true })], []);
    expect(await refreshCredits(h.deps, CFG, NOW)).toEqual({ upserted: 0, removed: 0, archived: 0 });
  });
  it('removes the row of an active item that now yields ledger or skip', async () => {
    const h = harness([item({ id: 'a' }), item({ id: 'b', status: 'Pledged', anonymous: true })],
      [row({ giftItemId: 'a' }), row({ giftItemId: 'b' })]);
    expect(await refreshCredits(h.deps, CFG, NOW)).toEqual({ upserted: 0, removed: 2, archived: 0 });
    expect(h.rows.size).toBe(0);
    expect(h.log.stateAsks).toEqual([]);
  });
  it('keeps a vanished item that is archived, stamping archivedAt', async () => {
    const h = harness([], [row()], { g1: 'archived' });
    expect(await refreshCredits(h.deps, CFG, NOW)).toEqual({ upserted: 0, removed: 0, archived: 1 });
    expect(h.rows.get('g1')).toEqual(row({ archivedAt: NOW }));
  });
  it('removes the row of a vanished item that is deleted or unknown to Monday', async () => {
    const h = harness([], [row({ giftItemId: 'd' }), row({ giftItemId: 'm' })], { d: 'deleted' });
    expect(await refreshCredits(h.deps, CFG, NOW)).toEqual({ upserted: 0, removed: 2, archived: 0 });
    expect(h.rows.size).toBe(0);
  });
  it('leaves a vanished item that still reads active (paging race)', async () => {
    const h = harness([], [row()], { g1: 'active' });
    expect(await refreshCredits(h.deps, CFG, NOW)).toEqual({ upserted: 0, removed: 0, archived: 0 });
    expect(h.rows.get('g1')).toEqual(row());
  });
  it('never re-checks or rewrites an already-archived row that is absent from the active read', async () => {
    const archived = row({ archivedAt: '2026-10-01T00:00:00Z' });
    const h = harness([], [archived], { g1: 'deleted' });
    expect(await refreshCredits(h.deps, CFG, NOW)).toEqual({ upserted: 0, removed: 0, archived: 0 });
    expect(h.log.stateAsks).toEqual([]);
    expect(h.rows.get('g1')).toEqual(archived);
  });
  it('clears the stamp when an archived item is restored and shows up active again', async () => {
    const h = harness([item({ anonymous: true })], [row({ archivedAt: '2026-10-01T00:00:00Z' })]);
    expect(await refreshCredits(h.deps, CFG, NOW)).toEqual({ upserted: 1, removed: 0, archived: 0 });
    expect(h.rows.get('g1')!.archivedAt).toBeNull();
  });
  it('does not remove an archived row whose restored item now yields ledger', async () => {
    const archived = row({ archivedAt: '2026-10-01T00:00:00Z' });
    const h = harness([item()], [archived]);
    expect(await refreshCredits(h.deps, CFG, NOW)).toEqual({ upserted: 0, removed: 0, archived: 0 });
    expect(h.rows.get('g1')).toEqual(archived);
  });
});
