import { describe, it, expect } from 'vitest';
import { runRecurring, RECURRING_WRITES_PER_RUN, type RecurringDetail } from './recurring';
import type { CustodianDeps, CustodianMondayClient } from './custodian';
import type { DonationRollupsConfig, OwnerColumns, RecurringGiftsConfig } from '../types';

const OWNER_COLS: OwnerColumns = { giftLedgerJson: 'c', lifetimeGiving: 'c', giftCount: 'c', firstGift: 'c', thisYearAmount: 'c',
  thisYearCount: 'c', lastYearAmount: 'c', lastYearCount: 'c', largestGift: 'c', smallestGift: 'c', averageGift: 'c',
  lastGiftDate: 'c', lastGiftAmount: 'c' };
const RECURRING: RecurringGiftsConfig = { boardId: 50, columns: { donorLink: 'donor', status: 'status' }, activeStatusLabel: 'Active' };

interface Fake {
  gifts: { id: string; statusLabel: string | null; donorItemIds: string[] }[];
  people: Record<string, { id: string; flag: string | null }[]>; // board id -> items
}

function deps(f: Fake, recurringGifts: RecurringGiftsConfig | null = RECURRING) {
  const writes: { boardId: number; itemId: string; values: Record<string, unknown> }[] = [];
  const mondayClient = {
    async pageRecurringGifts() { return { items: f.gifts, cursor: null }; },
    async pageItemsColumnsText(boardId: number, columnIds: string[]) {
      return { cursor: null, items: (f.people[String(boardId)] ?? []).map((i) => ({ id: i.id, text: new Map([[columnIds[0]!, i.flag]]) })) };
    },
    async changeColumnValues(boardId: number, itemId: string, values: Record<string, unknown>) { writes.push({ boardId, itemId, values }); },
  } as unknown as CustodianMondayClient;
  const config = { donationRollups: { recurringGifts, ownerColumnsByBoard: {
    '10': { ...OWNER_COLS, hasActiveRecurringGift: 'rg' },
    '20': OWNER_COLS, // Organizations: no flag column, never read
  } } } as unknown as DonationRollupsConfig;
  return { d: { mondayClient, config } as unknown as CustodianDeps, writes };
}

describe('runRecurring', () => {
  it('skips cleanly when Recurring Gifts is not configured', async () => {
    const { d, writes } = deps({ gifts: [], people: {} }, null);
    expect(await runRecurring(d)).toMatchObject({ ok: true, summary: expect.stringContaining('not configured') });
    expect(writes).toEqual([]);
  });

  it('checks donors with an Active gift, clears stale flags, and leaves agreeing cells alone', async () => {
    const { d, writes } = deps({
      gifts: [
        { id: 'g1', statusLabel: 'Active', donorItemIds: ['p1'] },
        { id: 'g2', statusLabel: 'Active', donorItemIds: ['p2'] },
        { id: 'g3', statusLabel: 'Canceled', donorItemIds: ['p3'] },
      ],
      people: { '10': [{ id: 'p1', flag: null }, { id: 'p2', flag: 'v' }, { id: 'p3', flag: 'v' }, { id: 'p4', flag: '' }],
        '20': [{ id: 'o1', flag: null }] },
    });
    const r = await runRecurring(d);
    expect(writes).toEqual([
      { boardId: 10, itemId: 'p1', values: { rg: { checked: 'true' } } },
      { boardId: 10, itemId: 'p3', values: { rg: null } },
    ]);
    expect(r.detail).toEqual({ activeDonors: 2, checked: 1, cleared: 1, remaining: 0 } satisfies RecurringDetail);
  });

  it('caps writes per run and reports the rest as remaining', async () => {
    const n = RECURRING_WRITES_PER_RUN + 3;
    const ids = Array.from({ length: n }, (_, i) => `p${i}`);
    const { d, writes } = deps({ gifts: [{ id: 'g', statusLabel: 'Active', donorItemIds: ids }],
      people: { '10': ids.map((id) => ({ id, flag: null })) } });
    const r = await runRecurring(d);
    expect(writes).toHaveLength(RECURRING_WRITES_PER_RUN);
    expect((r.detail as RecurringDetail).remaining).toBe(3);
  });
});
