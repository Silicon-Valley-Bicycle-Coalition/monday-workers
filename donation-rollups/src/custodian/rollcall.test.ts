import { describe, it, expect, vi, afterEach } from 'vitest';
import { runRollCall } from './rollcall';
import { runDuty, type CustodianDeps } from './custodian';
import type { ItemColumns, DonationCreditRecord } from '../monday/client';
import type { CreditRow, RollCallCreditsStore } from '../db/rollCallCredits';
import type { DonationRollupsConfig, RollCallConfig } from '../types';

const COLS: RollCallConfig['columns'] = { fiscalYear: 'fy', tier: 'tr', type: 'ty', listed: 'li', total: 'to', gifts: 'gi',
  people: 'pe', organization: 'or', reviewNote: 'rn', rowKey: 'rk' };
const ROLL_CALL: RollCallConfig = {
  boardId: 900, firstFiscalYear: 2026, excludedGiftTypes: ['Contracts'], writesPerRun: 500, columns: COLS,
  donations: { boardId: 100, columns: { amount: 'am', status: 'st', fiscalYear: 'dfy', giftType: 'gt', donorLink: 'dl', matchedBy: 'mb', anonymous: 'an' } },
  people: { '201': { householdId: 'hid', householdGreeting: 'hg', householdEmail: 'he', doNotSolicit: 'dns', dontList: 'pdl' } },
  organizations: { boardId: 300, columns: { recognitionName: 'rec', dontList: 'odl' } },
};

function config(rollCall: RollCallConfig | null = ROLL_CALL): DonationRollupsConfig {
  return {
    monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
    fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
    custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null,
      annualSummaryBoardId: null, annualSummaryColumns: null },
    affiliations: null,
    donationRollups: {
      donationBoards: [], receivedStatusLabel: 'Received', ownerColumnsByBoard: {}, membership: null, donorLevel: null,
      volunteerBoards: [], historicalVolunteerBoards: [], recurringGifts: null, rollCall,
    },
  };
}

// 2026-11-02 in Los Angeles is FY2027 (July start); FY2026 is still active with activeFiscalYears 2.
const NOW = new Date('2026-11-02T12:00:00Z');

interface LedgerGift { mondayItemId: string; ownerItemId: string; fiscalYear: number; amountCents: number; status: string; giftType: string | null }
const gift = (id: string, owner: string, cents: number, over: Partial<LedgerGift> = {}): LedgerGift =>
  ({ mondayItemId: id, ownerItemId: owner, fiscalYear: 2027, amountCents: cents, status: 'Received', giftType: 'Individual Donation', ...over });
const donation = (id: string, over: Partial<DonationCreditRecord> = {}): DonationCreditRecord =>
  ({ id, fiscalYear: 2027, amountCents: 10_000, status: 'Received', giftType: 'Individual Donation', donorItemIds: ['11'],
    matchedByItemIds: [], anonymous: false, ...over });
const item = (id: string, name: string, text: Record<string, string | null>, over: Partial<ItemColumns> = {}): ItemColumns =>
  ({ id, name, text: new Map(Object.entries(text)), values: new Map(), ...over });

interface Harness {
  ledger?: LedgerGift[];
  donations?: DonationCreditRecord[];
  boards?: Record<number, ItemColumns[]>;
  groups?: { id: string; title: string }[];
  rollCall?: RollCallConfig | null;
}

function harness(h: Harness) {
  const credits = new Map<string, CreditRow>();
  const writes: string[] = [];
  const created: { groupId: string; name: string; values: Record<string, unknown> }[] = [];
  const rollCallCredits: RollCallCreditsStore = {
    async all(fromFY) { return [...credits.values()].filter((r) => r.fiscalYear >= fromFY); },
    async upsert(rows) { for (const r of rows) credits.set(r.giftItemId, r); return rows.length; },
    async remove(ids) { for (const id of ids) credits.delete(id); },
    async markArchived() {},
  };
  const mondayClient = {
    async pageDonationCredits() { return { items: h.donations ?? [], cursor: null }; },
    async getItemsState() { return new Map(); },
    async pageItemsColumnsText(boardId: number) { return { items: h.boards?.[boardId] ?? [], cursor: null }; },
    async listGroups() { return h.groups ?? []; },
    async createGroup(_b: number, title: string) { writes.push(`group ${title}`); return `g-${title}`; },
    async updateGroupTitle(_b: number, id: string, title: string) { writes.push(`retitle ${id} ${title}`); },
    async createItemInGroup(_b: number, groupId: string, name: string, values: Record<string, unknown>) {
      writes.push(`create ${name}`);
      created.push({ groupId, name, values });
      return 'new';
    },
    async changeColumnValues(_b: number, id: string) { writes.push(`update ${id}`); },
    async moveItemToGroup(id: string) { writes.push(`move ${id}`); },
    async deleteItem(id: string) { writes.push(`delete ${id}`); },
    async createUpdate() {},
  };
  const deps = {
    gifts: {
      async countedGifts(fromFY: number) { return (h.ledger ?? []).filter((g) => g.fiscalYear >= fromFY); },
      async recordRun() {},
      async lastRuns() { return []; },
    },
    rollCallCredits, mondayClient, config: config(h.rollCall === undefined ? ROLL_CALL : h.rollCall), now: NOW,
  } as unknown as CustodianDeps;
  return { deps, writes, created, credits };
}

const PEOPLE: ItemColumns[] = [
  item('11', 'Pat Lee', { hid: 'H1', hg: 'Pat & Sam Lee', he: 'lees@example.org', dns: null, pdl: null }),
  item('12', 'Sam Lee', { hid: 'H1', hg: 'Pat & Sam Lee', he: 'lees@example.org', dns: 'v', pdl: null }),
  item('13', 'Ada Park', { hid: null, hg: null, he: null, dns: null, pdl: 'v' }),
];
const ORGS: ItemColumns[] = [item('31', 'Acme Inc', { rec: 'Acme Foundation', odl: null })];

afterEach(() => { vi.restoreAllMocks(); });

describe('runRollCall', () => {
  it('skips when not configured', async () => {
    const h = harness({ rollCall: null });
    expect(await runRollCall(h.deps, NOW)).toEqual({ ok: true, summary: 'rollcall: not configured, skipped' });
    expect(h.writes).toEqual([]);
  });

  it('credits ledger gifts, a household, an org, a matched gift and an anonymous gift into created rows', async () => {
    const h = harness({
      ledger: [
        gift('g1', '11', 50_000), gift('g2', '12', 20_000),
        gift('g3', '31', 100_000),
        // a matching gift the ledger credits to the employee, but Matched By says Acme: Acme only
        gift('g7', '11', 30_000, { giftType: 'Matching Donation' }),
        // a matching gift with no Matched By: the employee keeps it, flagged
        gift('g6', '13', 25_000, { giftType: 'Matching Donation' }),
        gift('g4', '13', 99_000, { giftType: 'Contracts' }),
        gift('g5', '13', 99_000, { status: 'Pledged' }),
      ],
      donations: [
        donation('a1', { anonymous: true, amountCents: 5_000, donorItemIds: [] }),
        donation('g7', { giftType: 'Matching Donation', matchedByItemIds: ['31'], amountCents: 30_000 }),
        donation('g6', { giftType: 'Matching Donation', donorItemIds: ['13'], amountCents: 25_000 }),
        donation('c1', { anonymous: true, giftType: 'Contracts' }),
      ],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] },
    });
    const report = await runRollCall(h.deps, NOW);
    expect(report.ok).toBe(true);
    expect(report.detail).toEqual({ rows: 4, unplaced: { gifts: 0, cents: 0 }, credits: { upserted: 3, removed: 0, archived: 0 },
      applied: 5, remaining: 0 });
    expect(h.writes).toEqual(['group FY2027 (in progress)', 'create Acme Foundation', 'create Pat & Sam Lee', 'create Ada Park', 'create Anonymous']);
    const byName = new Map(h.created.map((c) => [c.name, c.values]));
    expect(byName.get('Acme Foundation')).toMatchObject({ rk: '2027|item:31', to: '1300.00', gi: '2', tr: { label: '$1,000+' },
      ty: { label: 'Organization' }, or: { item_ids: [31] } });
    expect(byName.get('Pat & Sam Lee')).toMatchObject({ rk: '2027|household:H1', to: '700.00', gi: '2', ty: { label: 'Household' },
      pe: { item_ids: [11, 12] }, rn: { text: 'Do Not Solicit is checked on Sam Lee' } });
    expect(byName.get('Ada Park')).toMatchObject({ rk: '2027|item:13', to: '250.00', li: { label: "Don't list" },
      rn: { text: 'includes $250.00 of employer matching with no Matched By company' } });
    expect(byName.get('Anonymous')).toMatchObject({ rk: '2027|anonymous', to: '50.00', ty: { label: 'Anonymous' } });
    expect(h.created.every((c) => c.groupId === 'g-FY2027 (in progress)')).toBe(true);
  });

  it('reports a gift with no one to credit as unplaced, and not ok', async () => {
    const h = harness({
      ledger: [gift('g1', 'gone-person', 10_000)],
      donations: [donation('u1', { donorItemIds: [], amountCents: 4_000 })],
      boards: { 201: [], 300: [], 900: [] },
    });
    const report = await runRollCall(h.deps, NOW);
    expect(report.ok).toBe(false);
    expect((report.detail as { unplaced: unknown }).unplaced).toEqual({ gifts: 2, cents: 14_000 });
    expect(report.summary).toMatch(/2 gifts \(\$140\.00\) unplaced/);
  });

  it('freezes closed years: an FY2025 row whose donor vanished stays', async () => {
    // FY2025 is closed and archived (current FY2027, activeFiscalYears 2); the duty's first year
    // is set back to 2025 here so the frozen rule applies.
    const h = harness({
      rollCall: { ...ROLL_CALL, firstFiscalYear: 2025 },
      ledger: [gift('g1', '13', 10_000)],
      boards: { 201: PEOPLE, 300: ORGS,
        900: [item('50', 'Gone Donor', { rk: '2025|item:19', pe: null }, { groupId: 'old', linkedIds: new Map([['pe', ['19']]]) })] },
      groups: [{ id: 'old', title: 'FY2025' }, { id: 'cur', title: 'FY2027 (in progress)' }],
    });
    await runRollCall(h.deps, NOW);
    expect(h.writes).toEqual(['create Ada Park']);
  });
});

describe('runRollCall mass-delete guard', () => {
  const stale = (n: number) => Array.from({ length: n }, (_, i) =>
    item(String(1000 + i), `Old ${i}`, { rk: `2027|item:x${i}` }, { groupId: 'cur' }));
  const groups = [{ id: 'cur', title: 'FY2027 (in progress)' }];

  it('refuses to apply when more rows would go than max(10, 10% of the board)', async () => {
    const h = harness({ ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: stale(11) }, groups });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = await runDuty('rollcall', h.deps);
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/11 rows would be deleted.*force=1/);
    expect(h.writes).toEqual([]);
  });

  it('applies ten deletes, the floor of the limit', async () => {
    const h = harness({ ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: stale(10) }, groups });
    const report = await runDuty('rollcall', h.deps);
    expect(report.ok).toBe(true);
    expect(h.writes.filter((w) => w.startsWith('delete'))).toHaveLength(10);
  });

  it('refuses to apply when nothing was computed but the board has rows', async () => {
    const h = harness({ boards: { 201: PEOPLE, 300: ORGS, 900: stale(1) }, groups });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = await runDuty('rollcall', h.deps);
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/computed no rows/);
    expect(h.writes).toEqual([]);
  });

  it('force applies anyway', async () => {
    const h = harness({ ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: stale(11) }, groups });
    const report = await runDuty('rollcall', h.deps, { force: true });
    expect(report.ok).toBe(true);
    expect(h.writes.filter((w) => w.startsWith('delete'))).toHaveLength(11);
    expect(h.writes).toContain('create Ada Park');
  });
});
