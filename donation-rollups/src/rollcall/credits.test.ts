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
  it('decides the credit from the flags whatever the amount reads, so a $0 or blank one still suppresses the Donor', () => {
    expect(creditFor(item({ amountCents: 0, anonymous: true }), EXCLUDED)).toEqual({ credit: 'anonymous', unmatchedMatch: false });
    expect(creditFor(item({ amountCents: null, anonymous: true }), EXCLUDED)).toEqual({ credit: 'anonymous', unmatchedMatch: false });
    expect(creditFor(item({ amountCents: null, giftType: 'Matching Donation', matchedByItemIds: ['o9'] }), EXCLUDED))
      .toEqual({ credit: 'item:o9', unmatchedMatch: false });
    expect(creditFor(item({ amountCents: -500, donorItemIds: [] }), EXCLUDED)).toEqual({ credit: 'unplaced', unmatchedMatch: false });
    expect(creditFor(item({ amountCents: 0 }), EXCLUDED)).toBe('ledger');
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
const FY = 2027; // NOW's fiscal year
const row = (over: Partial<CreditRow> = {}): CreditRow => ({
  giftItemId: 'g1', fiscalYear: 2026, amountCents: 10_000, status: 'Received', giftType: 'Individual Donation',
  credit: 'anonymous', unmatchedMatch: false, archivedAt: null, ...over,
});

function harness(active: DonationCreditItem[], stored: CreditRow[], states: Record<string, 'active' | 'archived' | 'deleted'> = {}) {
  const rows = new Map(stored.map((r) => [r.giftItemId, r]));
  const log = { upserts: [] as CreditRow[], removes: [] as string[], archived: [] as string[], stateAsks: [] as string[][], startMonths: [] as number[] };
  const rollCallCredits: RollCallCreditsStore = {
    async all(fromFY) { return [...rows.values()].filter((r) => r.fiscalYear >= fromFY); },
    async upsert(rs) { for (const r of rs) { rows.set(r.giftItemId, r); log.upserts.push(r); } return rs.length; },
    async remove(ids) { for (const id of ids) rows.delete(id); log.removes.push(...ids); },
    async markArchived(ids, now) { for (const id of ids) rows.set(id, { ...rows.get(id)!, archivedAt: now }); log.archived.push(...ids); },
  };
  const mondayClient = {
    async pageDonationCredits(_c: unknown, cursor: string | null, startMonth: number) {
      log.startMonths.push(startMonth);
      return cursor === null ? { cursor: 'next', items: active.slice(0, 1) } : { cursor: null, items: active.slice(1) };
    },
    async getItemsState(ids: string[]) {
      log.stateAsks.push(ids);
      return new Map(ids.filter((id) => states[id] !== undefined).map((id) => [id, states[id]!] as const));
    },
  };
  const config = { fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' } };
  return { deps: { rollCallCredits, mondayClient, config } as unknown as CustodianDeps, rows, log };
}

describe('refreshCredits', () => {
  it('upserts an active anonymous gift across pages', async () => {
    const h = harness([item({ id: 'a', anonymous: true }), item({ id: 'b', anonymous: true })], []);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 2, removed: 0, archived: 0 });
    expect(h.rows.get('a')).toEqual(row({ giftItemId: 'a' }));
  });
  it('writes nothing for a gift the ledger credits or one before the first fiscal year', async () => {
    const h = harness([item({ id: 'a' }), item({ id: 'old', fiscalYear: 2025, anonymous: true })], []);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 0, archived: 0 });
  });
  it('removes the row of an active item that now yields ledger or skip', async () => {
    const h = harness([item({ id: 'a' }), item({ id: 'b', status: 'Pledged', anonymous: true })],
      [row({ giftItemId: 'a' }), row({ giftItemId: 'b' })]);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 2, archived: 0 });
    expect(h.rows.size).toBe(0);
    expect(h.log.stateAsks).toEqual([]);
  });
  it('keeps a vanished item that is archived, stamping archivedAt', async () => {
    const h = harness([item({ id: 'x' })], [row()], { g1: 'archived' });
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 0, archived: 1 });
    expect(h.rows.get('g1')).toEqual(row({ archivedAt: NOW }));
  });
  it('removes the row of a vanished item that is deleted or unknown to Monday', async () => {
    const h = harness([item({ id: 'x' })], [row({ giftItemId: 'd' }), row({ giftItemId: 'm' })], { d: 'deleted' });
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 2, archived: 0 });
    expect(h.rows.size).toBe(0);
  });
  it('leaves a vanished item that still reads active (paging race)', async () => {
    const h = harness([item({ id: 'x' })], [row()], { g1: 'active' });
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 0, archived: 0 });
    expect(h.rows.get('g1')).toEqual(row());
  });
  it('never re-checks or rewrites an already-archived row that is absent from the active read', async () => {
    const archived = row({ archivedAt: '2026-10-01T00:00:00Z' });
    const h = harness([], [archived], { g1: 'deleted' });
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 0, archived: 0 });
    expect(h.log.stateAsks).toEqual([]);
    expect(h.rows.get('g1')).toEqual(archived);
  });
  it('clears the stamp when an archived item is restored and shows up active again', async () => {
    const h = harness([item({ anonymous: true })], [row({ archivedAt: '2026-10-01T00:00:00Z' })]);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 1, removed: 0, archived: 0 });
    expect(h.rows.get('g1')!.archivedAt).toBeNull();
  });
  it('removes an archived row whose restored item now yields ledger or skip', async () => {
    const stamp = '2026-10-01T00:00:00Z';
    const h = harness([item({ id: 'a' }), item({ id: 'b', status: 'Pledged', anonymous: true })],
      [row({ giftItemId: 'a', archivedAt: stamp }), row({ giftItemId: 'b', archivedAt: stamp })]);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 2, archived: 0 });
    expect(h.rows.size).toBe(0);
  });
  it('passes the fiscal year start month, for a blank Fiscal Year Ending', async () => {
    const h = harness([item({ id: 'a', anonymous: true })], []);
    await refreshCredits(h.deps, CFG, NOW, FY);
    expect(h.log.startMonths).toEqual([7, 7]); // both pages
  });
  it('skips a gift dated after the current fiscal year, removing its stored row', async () => {
    const h = harness([item({ id: 'a', anonymous: true, fiscalYear: 2062 }), item({ id: 'b', anonymous: true, fiscalYear: 2028 })],
      [row({ giftItemId: 'b', fiscalYear: 2028 })]);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 1, archived: 0 });
    expect(h.rows.size).toBe(0);
  });
  it('refuses an empty Donations read while live rows are stored, writing nothing', async () => {
    const h = harness([], [row({ giftItemId: 'a' }), row({ giftItemId: 'b', archivedAt: '2026-10-01T00:00:00Z' })]);
    await expect(refreshCredits(h.deps, CFG, NOW, FY)).rejects.toThrow(/Donations board 7 read back no items.*1 stored/);
    expect(h.log.stateAsks).toEqual([]);
    expect(h.rows.size).toBe(2);
  });
  it('accepts an empty Donations read when every stored row is archived', async () => {
    const h = harness([], [row({ archivedAt: '2026-10-01T00:00:00Z' })]);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 0, archived: 0 });
  });
  it('stores the row of an anonymous gift whose Amount reads blank, with 0 cents', async () => {
    const h = harness([item({ id: 'a', anonymous: true, amountCents: null })], []);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 1, removed: 0, archived: 0 });
    expect(h.rows.get('a')).toEqual(row({ giftItemId: 'a', amountCents: 0 }));
  });
  it('upserts once when a paging race repeats an item', async () => {
    const h = harness([item({ anonymous: true }), item({ anonymous: true })], []);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 1, removed: 0, archived: 0 });
  });
});
