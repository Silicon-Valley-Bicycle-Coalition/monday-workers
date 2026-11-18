import { describe, it, expect } from 'vitest';
import { sharedBoardReads, sharedReadPlan } from './boardReads';
import type { CustodianMondayClient } from './custodian';
import type { ItemColumns } from '../monday/client';
import type { DonationRollupsConfig, OwnerColumns, RollCallConfig } from '../types';

// Issue GL#90: the nightly cron paged People and People (Historical) three times (membership,
// recurring, rollcall) and Donations twice (classify, rollcall credits). One read per board per run.

const item = (id: string, text: Record<string, string | null>, over: Partial<ItemColumns> = {}): ItemColumns =>
  ({ id, text: new Map(Object.entries(text)), values: new Map(), ...over });

interface Read { boardId: number; columnIds: string[]; cursor: string | null; requireBoard: boolean }

// Two pages per board, so a test sees the shared read walk every page once.
function fakeClient(boards: Record<number, ItemColumns[]>, reads: Read[]): CustodianMondayClient {
  return {
    async pageItemsColumnsText(boardId: number, columnIds: string[], cursor: string | null, opts: { requireBoard?: boolean } = {}) {
      reads.push({ boardId, columnIds: [...columnIds], cursor, requireBoard: opts.requireBoard === true });
      const items = boards[boardId];
      if (items === undefined) {
        if (opts.requireBoard) throw new Error(`monday API: board ${boardId} not returned`);
        return { items: [], cursor: null };
      }
      const half = Math.ceil(items.length / 2);
      return cursor === null ? { items: items.slice(0, half), cursor: half < items.length ? 'p2' : null } : { items: items.slice(half), cursor: null };
    },
    async pageDonationCredits() { throw new Error('should be served from the shared Donations read'); },
    async listGroups() { return []; },
  } as unknown as CustodianMondayClient;
}

async function pageAll(client: CustodianMondayClient, boardId: number, columnIds: string[], requireBoard = false): Promise<ItemColumns[]> {
  const out: ItemColumns[] = [];
  let cursor: string | null = null;
  do {
    const page: { items: ItemColumns[]; cursor: string | null } = await client.pageItemsColumnsText(boardId, columnIds, cursor, { requireBoard });
    out.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== null);
  return out;
}

describe('sharedBoardReads', () => {
  const PEOPLE = [item('p1', { ts: '2025-10-01', rg: 'v', hid: 'H1' }), item('p2', { ts: null, rg: null, hid: null }), item('p3', { ts: null, rg: 'v', hid: 'H2' })];

  it('reads a planned board once, with the union of columns, for every duty that pages it', async () => {
    const reads: Read[] = [];
    const client = sharedBoardReads(fakeClient({ 10: PEOPLE }, reads), new Map([[10, new Set(['ts', 'rg', 'hid'])]]));

    const a = await pageAll(client, 10, ['ts']);
    const b = await pageAll(client, 10, ['rg']);
    const c = await pageAll(client, 10, ['hid', 'rg'], true);

    expect(reads.map((r) => [r.boardId, r.cursor])).toEqual([[10, null], [10, 'p2']]);
    expect(reads[0]!.columnIds.sort()).toEqual(['hid', 'rg', 'ts']);
    for (const got of [a, b, c]) expect(got.map((i) => i.id)).toEqual(['p1', 'p2', 'p3']);
    expect(b[0]!.text.get('rg')).toBe('v');
    expect(c[2]!.text.get('hid')).toBe('H2');
  });

  it('passes through a board it has no plan for, or a column outside the plan', async () => {
    const reads: Read[] = [];
    const client = sharedBoardReads(fakeClient({ 10: PEOPLE, 20: [item('e1', { start: '2026-01-01' })] }, reads),
      new Map([[10, new Set(['ts'])]]));
    await pageAll(client, 20, ['start']);
    await pageAll(client, 10, ['ts', 'other']);
    expect(reads.map((r) => [r.boardId, r.columnIds.join(',')])).toEqual([[20, 'start'], [10, 'ts,other'], [10, 'ts,other']]);
  });

  it('a failed shared read falls back to each caller\'s own read, keeping requireBoard semantics', async () => {
    const reads: Read[] = [];
    const client = sharedBoardReads(fakeClient({}, reads), new Map([[10, new Set(['ts', 'hid'])]]));
    expect(await pageAll(client, 10, ['ts'])).toEqual([]);                    // not required: empty, as before
    await expect(pageAll(client, 10, ['hid'], true)).rejects.toThrow(/board 10 not returned/);
  });

  it('serves pageDonationCredits from the same Donations read classify uses', async () => {
    const reads: Read[] = [];
    const credits: RollCallConfig['donations'] = { boardId: 100,
      columns: { amount: 'am', date: 'dt', status: 'st', fiscalYear: 'fy', giftType: 'gt', donorLink: 'dl', matchedBy: 'mb', anonymous: 'an' } };
    const donations = [item('g1', { am: '$1,250.50', dt: '2026-08-01', st: 'Received', fy: null, gt: 'Matching Donation', dl: null, mb: null, an: null, fs: 'x' },
      { values: new Map([['st', '{"index":1}'], ['an', '{"checked":"true"}']]), linkedIds: new Map([['dl', ['p1']], ['mb', ['o1']]]) })];
    const client = sharedBoardReads(fakeClient({ 100: donations }, reads),
      new Map([[100, new Set(['am', 'dt', 'st', 'fy', 'gt', 'dl', 'mb', 'an', 'fs'])]]));

    await pageAll(client, 100, ['am', 'dt', 'fs']);
    const page = await client.pageDonationCredits(credits, null, 7);

    expect(reads).toHaveLength(1);
    expect(page).toEqual({ cursor: null, items: [{ id: 'g1', fiscalYear: 2027, amountCents: 125050, status: 'Received',
      giftType: 'Matching Donation', donorItemIds: ['p1'], matchedByItemIds: ['o1'], anonymous: true, inKindValueCents: null,
      recognitionFiscalYear: '' }] });
  });
});

describe('sharedReadPlan', () => {
  const OWNER: OwnerColumns = { giftLedgerJson: 'c', lifetimeGiving: 'c', giftCount: 'c', firstGift: 'c', thisYearAmount: 'c',
    thisYearCount: 'c', lastYearAmount: 'c', lastYearCount: 'c', largestGift: 'c', smallestGift: 'c', averageGift: 'c',
    lastGiftDate: 'c', lastGiftAmount: 'c' };

  it('unions the People columns of membership, recurring and rollcall, and the Donations columns of classify and rollcall', () => {
    const config = {
      fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
      donationRollups: {
        donationBoards: [{ boardId: 100, columns: { donorLink: 'dl', amount: 'am', date: 'dt', status: 'st', fiscalYear: 'fy',
          giftType: 'gt', actingForLink: null,
          classification: { fundingStream: 'fs', giftSize: 'gs', fiscalQuarter: 'fq', giftFiscalYear: 'gfy' } } }],
        ownerColumnsByBoard: {
          '10': { ...OWNER, hasActiveRecurringGift: 'rg', membership: { currentTermStart: 'ts', status: 'ms', tier: 'mt', until: 'mu' } },
          '20': OWNER,
        },
        membership: { termMonths: 13 },
        recurringGifts: { boardId: 50, columns: { donorLink: 'x', status: 'y' }, activeStatusLabel: 'Active' },
        rollCall: { boardId: 900, columns: {},
          donations: { boardId: 100, columns: { amount: 'am', date: 'dt', status: 'st', fiscalYear: 'fy', giftType: 'gt', donorLink: 'dl', matchedBy: 'mb', anonymous: 'an' } },
          people: { '10': { householdId: 'hid', householdGreeting: 'hg', householdEmail: 'he', doNotSolicit: 'dns', dontList: 'pdl' } },
          organizations: { boardId: 20, columns: { recognitionName: 'rec', dontList: 'odl' } } },
      },
    } as unknown as DonationRollupsConfig;

    const plan = sharedReadPlan(config);
    expect([...plan.keys()].sort((a, b) => a - b)).toEqual([10, 20, 100]);
    expect([...plan.get(10)!].sort()).toEqual(['dns', 'he', 'hg', 'hid', 'ms', 'mt', 'mu', 'pdl', 'rg', 'ts']);
    expect([...plan.get(20)!].sort()).toEqual(['odl', 'rec']);
    expect([...plan.get(100)!].sort()).toEqual(['am', 'an', 'dl', 'dt', 'fq', 'fs', 'fy', 'gfy', 'gs', 'gt', 'mb', 'st']);
  });
});
