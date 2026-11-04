import { describe, it, expect } from 'vitest';
import { countedCents, creditFor, recognitionYear, refreshCredits, type DonationCreditItem } from './credits';
import type { CustodianDeps } from '../custodian/custodian';
import type { CreditRow, RollCallCreditsStore } from '../db/rollCallCredits';
import type { RollCallConfig } from '../types';

const EXCLUDED = ['Contracts'];
const YEARS = { first: 2026, current: 2027 };
const item = (over: Partial<DonationCreditItem> = {}): DonationCreditItem => ({
  id: 'g1', fiscalYear: 2026, amountCents: 10_000, status: 'Received', giftType: 'Individual Donation',
  donorItemIds: ['p1'], matchedByItemIds: [], anonymous: false, inKindValueCents: null, recognitionFiscalYear: '', ...over,
});

describe('recognitionYear', () => {
  it('reads 2026 or FY2026 in any case and spacing; blank or the own year is no override', () => {
    expect(recognitionYear('2026', 2025)).toBe(2026);
    expect(recognitionYear(' fy 2026 ', 2025)).toBe(2026);
    expect(recognitionYear('FY2026', 2027)).toBe(2026);
    expect(recognitionYear('', 2025)).toBeNull();
    expect(recognitionYear('2025', 2025)).toBeNull();
  });
  it('calls anything else invalid', () => {
    for (const t of ['FY26', '26', '2026-27', 'next year', '2,026']) expect(recognitionYear(t, 2025)).toBe('invalid');
  });
});

describe('countedCents', () => {
  it('counts Amount, or In-Kind Value when Amount is blank or zero', () => {
    expect(countedCents({ amountCents: 5_000, inKindValueCents: 200_000 })).toBe(5_000);
    expect(countedCents({ amountCents: null, inKindValueCents: 200_000 })).toBe(200_000);
    expect(countedCents({ amountCents: 0, inKindValueCents: 200_000 })).toBe(200_000);
    expect(countedCents({ amountCents: null, inKindValueCents: null })).toBeNull();
    expect(countedCents({ amountCents: 0, inKindValueCents: 0 })).toBe(0);
  });
});

describe('creditFor', () => {
  it('skips an excluded gift type, a gift that is not received, and a fiscal year unparseable or out of range', () => {
    expect(creditFor(item({ giftType: 'Contracts' }), EXCLUDED, YEARS)).toBe('skip');
    expect(creditFor(item({ status: 'Pledged' }), EXCLUDED, YEARS)).toBe('skip');
    expect(creditFor(item({ status: null }), EXCLUDED, YEARS)).toBe('skip');
    expect(creditFor(item({ fiscalYear: 0 }), EXCLUDED, YEARS)).toBe('skip');
    expect(creditFor(item({ fiscalYear: NaN }), EXCLUDED, YEARS)).toBe('skip');
    expect(creditFor(item({ fiscalYear: 2025, donorItemIds: [] }), EXCLUDED, YEARS)).toBe('skip');
    expect(creditFor(item({ fiscalYear: 2062, giftType: 'Matching Donation' }), EXCLUDED, YEARS)).toBe('skip');
  });
  it('keeps an Anonymous or Matched By credit whatever decides counting, so the ledger can never name the Donor', () => {
    const anon = { credit: 'anonymous', unmatchedMatch: false };
    const matched = { credit: 'item:o9', unmatchedMatch: false };
    expect(creditFor(item({ anonymous: true, giftType: 'Contracts' }), EXCLUDED, YEARS)).toEqual(anon);
    for (const over of [{ status: 'Pledged' }, { status: null }, { fiscalYear: 0 }, { fiscalYear: NaN },
      { fiscalYear: 2025 }, { fiscalYear: 2062 }] as Partial<DonationCreditItem>[]) {
      expect(creditFor(item({ anonymous: true, ...over }), EXCLUDED, YEARS)).toEqual(anon);
      expect(creditFor(item({ giftType: 'Matching Donation', matchedByItemIds: ['o9'], ...over }), EXCLUDED, YEARS)).toEqual(matched);
    }
  });
  it('decides the credit from the flags whatever the amount reads, so a $0 or blank one still suppresses the Donor', () => {
    expect(creditFor(item({ amountCents: 0, anonymous: true }), EXCLUDED, YEARS)).toEqual({ credit: 'anonymous', unmatchedMatch: false });
    expect(creditFor(item({ amountCents: null, anonymous: true }), EXCLUDED, YEARS)).toEqual({ credit: 'anonymous', unmatchedMatch: false });
    expect(creditFor(item({ amountCents: null, giftType: 'Matching Donation', matchedByItemIds: ['o9'] }), EXCLUDED, YEARS))
      .toEqual({ credit: 'item:o9', unmatchedMatch: false });
    expect(creditFor(item({ amountCents: -500, donorItemIds: [] }), EXCLUDED, YEARS)).toEqual({ credit: 'unplaced', unmatchedMatch: false });
    expect(creditFor(item({ amountCents: 0 }), EXCLUDED, YEARS)).toBe('ledger');
  });
  it('credits a matching gift to its Matched By company, even when anonymous', () => {
    expect(creditFor(item({ giftType: 'Matching Donation', matchedByItemIds: ['o9'] }), EXCLUDED, YEARS))
      .toEqual({ credit: 'item:o9', unmatchedMatch: false });
    expect(creditFor(item({ giftType: 'Matching Donation', matchedByItemIds: ['o9'], anonymous: true }), EXCLUDED, YEARS))
      .toEqual({ credit: 'item:o9', unmatchedMatch: false });
  });
  it('credits an anonymous gift to the anonymous row, flag over Donor', () => {
    expect(creditFor(item({ anonymous: true }), EXCLUDED, YEARS)).toEqual({ credit: 'anonymous', unmatchedMatch: false });
  });
  it('counts a gift with no Donor and no flag as unplaced', () => {
    expect(creditFor(item({ donorItemIds: [] }), EXCLUDED, YEARS)).toEqual({ credit: 'unplaced', unmatchedMatch: false });
  });
  it('flags a matching gift with no Matched By but a Donor, carrying no credit', () => {
    expect(creditFor(item({ giftType: 'Matching Donation' }), EXCLUDED, YEARS)).toEqual({ credit: null, unmatchedMatch: true });
  });
  it('carries a Recognition Fiscal Year on a credit-null row whatever decides counting, own year in or out of range', () => {
    const carry = { credit: null, unmatchedMatch: false };
    expect(creditFor(item({ fiscalYear: 2025, recognitionFiscalYear: '2026' }), EXCLUDED, YEARS)).toEqual(carry);
    expect(creditFor(item({ fiscalYear: 2027, recognitionFiscalYear: 'FY2026' }), EXCLUDED, YEARS)).toEqual(carry);
    expect(creditFor(item({ fiscalYear: 2025, recognitionFiscalYear: '2026', status: 'Pledged' }), EXCLUDED, YEARS)).toEqual(carry);
    expect(creditFor(item({ recognitionFiscalYear: '2028' }), EXCLUDED, YEARS)).toEqual(carry);
    expect(creditFor(item({ giftType: 'Matching Donation', recognitionFiscalYear: '2027' }), EXCLUDED, YEARS))
      .toEqual({ credit: null, unmatchedMatch: true });
  });
  it('keeps Anonymous and Matched By credits under a Recognition Fiscal Year: it moves the year, not the donor', () => {
    expect(creditFor(item({ anonymous: true, recognitionFiscalYear: '2027' }), EXCLUDED, YEARS)).toEqual({ credit: 'anonymous', unmatchedMatch: false });
  });
  it('judges a donorless gift by its Recognition Fiscal Year', () => {
    expect(creditFor(item({ fiscalYear: 2025, donorItemIds: [], recognitionFiscalYear: '2026' }), EXCLUDED, YEARS))
      .toEqual({ credit: 'unplaced', unmatchedMatch: false });
    expect(creditFor(item({ donorItemIds: [], recognitionFiscalYear: '2025' }), EXCLUDED, YEARS)).toBe('skip');
    expect(creditFor(item({ donorItemIds: [], recognitionFiscalYear: '2028' }), EXCLUDED, YEARS)).toBe('skip');
  });
  it('ignores an unreadable or own-year Recognition Fiscal Year', () => {
    expect(creditFor(item({ recognitionFiscalYear: 'FY26' }), EXCLUDED, YEARS)).toBe('ledger');
    expect(creditFor(item({ recognitionFiscalYear: '2026' }), EXCLUDED, YEARS)).toBe('ledger');
    expect(creditFor(item({ fiscalYear: 2025, recognitionFiscalYear: 'FY26' }), EXCLUDED, YEARS)).toBe('skip');
  });
  it('carries an in-kind amount for a gift with no Amount on a credit-null row', () => {
    expect(creditFor(item({ amountCents: null, inKindValueCents: 200_000 }), EXCLUDED, YEARS)).toEqual({ credit: null, unmatchedMatch: false });
    expect(creditFor(item({ amountCents: 5_000, inKindValueCents: 200_000 }), EXCLUDED, YEARS)).toBe('ledger');
  });
  it('leaves an ordinary donor gift to the ledger', () => {
    expect(creditFor(item(), EXCLUDED, YEARS)).toBe('ledger');
    expect(creditFor(item({ status: 'Received (Historical)' }), EXCLUDED, YEARS)).toBe('ledger');
  });
});

const CFG = { firstFiscalYear: 2026, excludedGiftTypes: EXCLUDED, donations: { boardId: 7, columns: {} } } as unknown as RollCallConfig;
const NOW = '2026-11-02T00:00:00Z';
const FY = 2027; // NOW's fiscal year
const row = (over: Partial<CreditRow> = {}): CreditRow => ({
  giftItemId: 'g1', fiscalYear: 2026, recognitionFiscalYear: null, amountCents: 10_000, status: 'Received', giftType: 'Individual Donation',
  credit: 'anonymous', unmatchedMatch: false, archivedAt: null, ...over,
});

function harness(active: DonationCreditItem[], stored: CreditRow[], states: Record<string, 'active' | 'archived' | 'deleted'> = {}) {
  const rows = new Map(stored.map((r) => [r.giftItemId, r]));
  const log = { upserts: [] as CreditRow[], removes: [] as string[], archived: [] as string[], stateAsks: [] as string[][], startMonths: [] as number[] };
  const rollCallCredits: RollCallCreditsStore = {
    async all() { return [...rows.values()]; },
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
  it('writes nothing for a gift the ledger credits or an unplaced one before the first fiscal year', async () => {
    const h = harness([item({ id: 'a' }), item({ id: 'old', fiscalYear: 2025, donorItemIds: [] })], []);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 0, archived: 0 });
  });
  it('keeps the row of an anonymous gift that stops counting, in any year, an unreadable one stored as 0', async () => {
    const h = harness([item({ id: 'a', status: 'Pledged', anonymous: true }), item({ id: 'b', fiscalYear: 2025, anonymous: true }),
      item({ id: 'c', fiscalYear: NaN, anonymous: true })], [row({ giftItemId: 'a' }), row({ giftItemId: 'b' })]);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 3, removed: 0, archived: 0 });
    expect(h.rows.get('a')).toEqual(row({ giftItemId: 'a', status: 'Pledged' }));
    expect(h.rows.get('b')).toEqual(row({ giftItemId: 'b', fiscalYear: 2025 }));
    expect(h.rows.get('c')).toEqual(row({ giftItemId: 'c', fiscalYear: 0 }));
  });
  it('removes the row of an active item that now yields ledger or skip', async () => {
    const h = harness([item({ id: 'a' }), item({ id: 'b', status: 'Pledged', donorItemIds: [] })],
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
    const h = harness([item({ id: 'a' }), item({ id: 'b', status: 'Pledged', donorItemIds: [] })],
      [row({ giftItemId: 'a', archivedAt: stamp }), row({ giftItemId: 'b', archivedAt: stamp })]);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 2, archived: 0 });
    expect(h.rows.size).toBe(0);
  });
  it('passes the fiscal year start month, for a blank Fiscal Year Ending', async () => {
    const h = harness([item({ id: 'a', anonymous: true })], []);
    await refreshCredits(h.deps, CFG, NOW, FY);
    expect(h.log.startMonths).toEqual([7, 7]); // both pages
  });
  it('skips an unflagged gift dated after the current fiscal year, removing its stored row', async () => {
    const h = harness([item({ id: 'a', donorItemIds: [], fiscalYear: 2062 }), item({ id: 'b', donorItemIds: [], fiscalYear: 2028 })],
      [row({ giftItemId: 'b', fiscalYear: 2028, credit: 'unplaced' })]);
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
  it('stores a Recognition Fiscal Year and an in-kind amount, and reports an unreadable year', async () => {
    const h = harness([item({ id: 'z', fiscalYear: 2025, recognitionFiscalYear: '2026' }),
      item({ id: 'k', fiscalYear: 2027, amountCents: null, inKindValueCents: 200_000 }),
      item({ id: 'bad', recognitionFiscalYear: 'FY26' })], []);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 2, removed: 0, archived: 0, badRecognitionYears: ['bad'] });
    expect(h.rows.get('z')).toEqual(row({ giftItemId: 'z', fiscalYear: 2025, recognitionFiscalYear: 2026, credit: null }));
    expect(h.rows.get('k')).toEqual(row({ giftItemId: 'k', fiscalYear: 2027, amountCents: 200_000, credit: null }));
  });
  it('drops the row when staff clear the Recognition Fiscal Year on an active gift', async () => {
    const h = harness([item({ id: 'z', fiscalYear: 2026 })], [row({ giftItemId: 'z', recognitionFiscalYear: 2027, credit: null })]);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 0, removed: 1, archived: 0 });
  });
  it('keeps the Recognition Fiscal Year of a gift that archives again after staff restored it to set one', async () => {
    // Night 1: restored and set. Night 2: archived again by hand — the row is stamped, not dropped.
    const h = harness([item({ id: 'z', fiscalYear: 2025, recognitionFiscalYear: '2026' }), item({ id: 'x' })], []);
    await refreshCredits(h.deps, CFG, NOW, FY);
    const later = harness([item({ id: 'x' })], [...h.rows.values()], { z: 'archived' });
    expect(await refreshCredits(later.deps, CFG, '2026-11-04T00:00:00Z', FY)).toEqual({ upserted: 0, removed: 0, archived: 1 });
    expect(later.rows.get('z')).toEqual(row({ giftItemId: 'z', fiscalYear: 2025, recognitionFiscalYear: 2026, credit: null,
      archivedAt: '2026-11-04T00:00:00Z' }));
  });
  it('upserts once when a paging race repeats an item', async () => {
    const h = harness([item({ anonymous: true }), item({ anonymous: true })], []);
    expect(await refreshCredits(h.deps, CFG, NOW, FY)).toEqual({ upserted: 1, removed: 0, archived: 0 });
  });
});
