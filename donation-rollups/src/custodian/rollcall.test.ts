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
  donations: { boardId: 100, columns: { amount: 'am', date: 'dt', status: 'st', fiscalYear: 'dfy', giftType: 'gt', donorLink: 'dl', matchedBy: 'mb', anonymous: 'an' } },
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
      volunteerBoards: [], historicalVolunteerBoards: [], recurringGifts: null, rollCall, sponsorships: null,
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
    matchedByItemIds: [], anonymous: false, inKindValueCents: null, recognitionFiscalYear: '', ...over });
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
  const reads: { boardId: number; requireBoard: boolean }[] = [];
  const created: { groupId: string; name: string; values: Record<string, unknown> }[] = [];
  const rollCallCredits: RollCallCreditsStore = {
    async all() { return [...credits.values()]; },
    async upsert(rows) { for (const r of rows) credits.set(r.giftItemId, r); return rows.length; },
    async remove(ids) { for (const id of ids) credits.delete(id); },
    async markArchived() {},
  };
  const mondayClient = {
    async pageDonationCredits() { return { items: h.donations ?? [], cursor: null }; },
    async getItemsState() { return new Map(); },
    // Like the real client: with requireBoard, a board Monday doesn't return throws.
    async pageItemsColumnsText(boardId: number, _c: string[], _cursor: string | null, opts: { requireBoard?: boolean } = {}) {
      reads.push({ boardId, requireBoard: opts.requireBoard === true });
      if (h.boards?.[boardId] === undefined && opts.requireBoard) throw new Error(`monday API: board ${boardId} not returned`);
      return { items: h.boards?.[boardId] ?? [], cursor: null };
    },
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
      async countedGifts(fromFY: number, alsoIds: string[] = []) {
        return (h.ledger ?? []).filter((g) => g.fiscalYear >= fromFY || alsoIds.includes(g.mondayItemId));
      },
      async recordRun() {},
      async lastRuns() { return []; },
    },
    rollCallCredits, mondayClient, config: config(h.rollCall === undefined ? ROLL_CALL : h.rollCall), now: NOW,
  } as unknown as CustodianDeps;
  return { deps, writes, created, credits, reads };
}

const PEOPLE: ItemColumns[] = [
  item('11', 'Pat Lee', { hid: 'H1', hg: 'Pat & Sam Lee', he: 'lees@example.org', dns: null, pdl: null }),
  item('12', 'Sam Lee', { hid: 'H1', hg: 'Pat & Sam Lee', he: 'lees@example.org', dns: 'v', pdl: null }),
  item('13', 'Ada Park', { hid: null, hg: null, he: null, dns: null, pdl: 'v' }),
];
const ORGS: ItemColumns[] = [item('31', 'Acme Inc', { rec: 'Acme Foundation', odl: null })];

afterEach(() => { vi.restoreAllMocks(); });

describe('runRollCall mailing address (spec §11)', () => {
  const HOME = '12 Oak St, San Jose, CA, 95113';
  const ADDRESSED: RollCallConfig = { ...ROLL_CALL, columns: { ...COLS, mailingAddress: 'ma' },
    people: { '201': { ...ROLL_CALL.people['201']!, address: 'addr', doNotMail: 'dnm' } },
    organizations: { boardId: 300, columns: { ...ROLL_CALL.organizations.columns, address: 'oaddr' } } };
  const donors = {
    201: [item('11', 'Pat Lee', { hid: null, hg: null, he: null, dns: null, pdl: null, addr: HOME, dnm: null }),
      item('13', 'Ada Park', { hid: null, hg: null, he: null, dns: null, pdl: null, addr: HOME, dnm: 'v' })],
    300: [item('31', 'Acme Inc', { rec: null, odl: null, oaddr: '1 Main St, Campbell, CA, 95008' })],
    900: [],
  };
  const ledger = [gift('g1', '11', 50_000), gift('g2', '13', 40_000), gift('g3', '31', 30_000)];

  it('writes each donor\'s address, blank under Do Not Mail', async () => {
    const h = harness({ ledger, boards: donors, rollCall: ADDRESSED });
    await runRollCall(h.deps, NOW);
    const cell = (name: string) => h.created.find((c) => c.name === name)!.values.ma;
    expect(cell('Pat Lee')).toBe(HOME);
    expect(cell('Acme Inc')).toBe('1 Main St, Campbell, CA, 95008');
    expect(cell('Ada Park')).toBe('');
  });

  it('stays off until the board column is configured: no cell and no address notes', async () => {
    const off = { ...ADDRESSED, columns: COLS };
    const h = harness({ ledger, boards: donors, rollCall: off });
    await runRollCall(h.deps, NOW);
    const ada = h.created.find((c) => c.name === 'Ada Park')!.values;
    expect(ada).not.toHaveProperty('ma');
    expect(ada.rn).toEqual({ text: '' });
  });
});

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
    // upserted 4: c1 keeps its anonymous row though Contracts never counts (credits follow the flags).
    expect(report.detail).toEqual({ rows: 4, unplaced: { gifts: 0, cents: 0 }, credits: { upserted: 4, removed: 0, archived: 0 },
      pendingLedger: 0, applied: 5, remaining: 0 });
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

  // Issue GL#90: the credits table and the board's groups were each read twice a run.
  it('reads the credits table and the board groups once a run', async () => {
    const h = harness({ ledger: [gift('g1', '11', 50_000)], donations: [donation('a1', { anonymous: true, donorItemIds: [] })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] }, groups: [{ id: 'old', title: 'FY2026' }] });
    const all = vi.spyOn(h.deps.rollCallCredits, 'all');
    const listGroups = vi.spyOn(h.deps.mondayClient, 'listGroups');
    const report = await runRollCall(h.deps, NOW);
    expect(all).toHaveBeenCalledOnce();
    expect(listGroups).toHaveBeenCalledOnce();
    // The rows still see this run's credits refresh: the anonymous gift is counted.
    expect(h.writes).toContain('create Anonymous');
    expect(report.ok).toBe(true);
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

  it('reads every board with requireBoard, and fails on a board Monday does not return', async () => {
    const h = harness({ ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: [] } });
    await runRollCall(h.deps, NOW);
    expect(h.reads.map((r) => r.boardId).sort()).toEqual([201, 300, 900]);
    expect(h.reads.every((r) => r.requireBoard)).toBe(true);
    const missing = harness({ ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 900: [] } });
    await expect(runRollCall(missing.deps, NOW)).rejects.toThrow(/board 300/);
    expect(missing.writes).toEqual([]);
  });

  it('ignores gifts dated after the current fiscal year', async () => {
    const h = harness({
      ledger: [gift('g1', '13', 10_000), gift('g2', '13', 50_000, { fiscalYear: 2062 })],
      donations: [donation('a1', { anonymous: true, fiscalYear: 2062 })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] },
    });
    const report = await runRollCall(h.deps, NOW);
    expect((report.detail as { rows: number }).rows).toBe(1);
    expect(h.writes).toEqual(['group FY2027 (in progress)', 'create Ada Park']);
    expect(h.created[0]!.values).toMatchObject({ to: '100.00' });
  });

  it('counts a flagged gift the ledger has not caught up with as pendingLedger, not an error', async () => {
    // g6 is a Matching Donation with no Matched By: its credits row has credit null and waits on
    // the ledger's own row (the consumer hasn't recomputed it yet), so it isn't counted tonight.
    const h = harness({
      ledger: [gift('g1', '13', 10_000)],
      donations: [donation('g6', { giftType: 'Matching Donation', donorItemIds: ['13'], amountCents: 25_000 })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] },
    });
    const report = await runRollCall(h.deps, NOW);
    expect(report.ok).toBe(true);
    expect(report.detail).toMatchObject({ pendingLedger: 1 });
    expect(report.summary).toMatch(/1 flagged gift waiting on the ledger/);
    expect(h.created[0]!.values).toMatchObject({ to: '100.00' });
  });

  it('counts no gift of zero or negative cents, from the ledger or from a stored credits row', async () => {
    const h = harness({
      // Ada: a real gift and a $0 one; Pat: only a $0 gift, so no row at all.
      ledger: [gift('g1', '13', 10_000), gift('g2', '13', 0), gift('g3', '11', 0), gift('g4', '31', -5_000)],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] },
    });
    // A $0 anonymous gift stored before this rule: it must not count either.
    h.credits.set('a0', { giftItemId: 'a0', fiscalYear: 2027, recognitionFiscalYear: null, amountCents: 0, status: 'Received', giftType: 'Individual Donation',
      credit: 'anonymous', unmatchedMatch: false, archivedAt: '2026-10-01T00:00:00Z' });
    const report = await runRollCall(h.deps, NOW);
    expect((report.detail as { rows: number }).rows).toBe(1);
    expect(h.writes).toEqual(['group FY2027 (in progress)', 'create Ada Park']);
    expect(h.created[0]!.values).toMatchObject({ to: '100.00', gi: '1' });
  });

  it('never names the donor of an anonymous gift whose Amount reads blank, night after night', async () => {
    // The ledger (its own Amount parse) has a1 at $500 for Ada; the roll call's read of a1's
    // Amount is blank. The Anonymous flag still wins: no credit to Ada, and the gift doesn't count.
    const h = harness({
      ledger: [gift('g1', '13', 10_000), gift('a1', '13', 50_000)],
      donations: [donation('a1', { anonymous: true, amountCents: null, donorItemIds: ['13'] })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] },
    });
    // The fake board never fills in, so each night creates the one row again: check it each time.
    for (let night = 0; night < 2; night++) {
      h.created.length = 0;
      const report = await runRollCall(h.deps, NOW);
      expect((report.detail as { rows: number }).rows).toBe(1);
      expect(h.created.map((c) => [c.name, (c.values as Record<string, unknown>).to, (c.values as Record<string, unknown>).gi]))
        .toEqual([['Ada Park', '100.00', '1']]);
      expect(h.credits.get('a1')).toMatchObject({ credit: 'anonymous', amountCents: 0 });
    }
  });

  // The ledger keeps a gift's facts from the consumer's last read, and that read skips a gift
  // with a blank Date (getDonationsByIds), so it can still count a gift the nightly read sees
  // as not counting. The flag must keep winning in every such case, night after night.
  describe.each([
    ['its Date is cleared (fiscal year unreadable)', { fiscalYear: 0 }],
    ['it reads Pledged', { status: 'Pledged' }],
    ['its Status is blank', { status: null }],
    ['its gift type is now excluded', { giftType: 'Contracts' }],
    ['it is redated before the first fiscal year', { fiscalYear: 2025 }],
    ['it is redated past the current fiscal year', { fiscalYear: 2062 }],
  ] as [string, Partial<DonationCreditRecord>][])('while the ledger still counts a gift after %s', (_label, change) => {
    it('never names the donor of the anonymous gift', async () => {
      const h = harness({
        ledger: [gift('g1', '13', 10_000), gift('a1', '13', 50_000)],
        donations: [donation('a1', { anonymous: true, donorItemIds: ['13'] })],
        boards: { 201: PEOPLE, 300: ORGS, 900: [] },
      });
      await runRollCall(h.deps, NOW); // night one: the gift counts, credited anonymously
      h.created.length = 0;
      h.writes.length = 0;
      (h.deps.mondayClient as unknown as { pageDonationCredits: () => Promise<unknown> }).pageDonationCredits =
        async () => ({ items: [donation('a1', { anonymous: true, donorItemIds: ['13'], ...change })], cursor: null });
      for (let night = 0; night < 2; night++) {
        h.created.length = 0;
        await runRollCall(h.deps, NOW);
        expect(h.created.find((c) => c.name === 'Ada Park')?.values).toMatchObject({ to: '100.00', gi: '1' });
        expect(h.credits.get('a1')).toMatchObject({ credit: 'anonymous' });
      }
    });
    // A type that isn't Matching Donation clears the Matched By flag itself, so no company credit.
    it.skipIf(change.giftType !== undefined)('never credits the Matched By gift to the employee', async () => {
      const h = harness({
        ledger: [gift('g1', '13', 10_000), gift('m1', '13', 30_000, { giftType: 'Matching Donation' })],
        donations: [donation('m1', { giftType: 'Matching Donation', matchedByItemIds: ['31'], donorItemIds: ['13'] })],
        boards: { 201: PEOPLE, 300: ORGS, 900: [] },
      });
      (h.deps.mondayClient as unknown as { pageDonationCredits: () => Promise<unknown> }).pageDonationCredits =
        async () => ({ items: [donation('m1', { giftType: 'Matching Donation', matchedByItemIds: ['31'], donorItemIds: ['13'], ...change })], cursor: null });
      for (let night = 0; night < 2; night++) {
        h.created.length = 0;
        await runRollCall(h.deps, NOW);
        expect(h.created.find((c) => c.name === 'Ada Park')?.values).toMatchObject({ to: '100.00', gi: '1' });
      }
    });
  });

  it('never credits a $0 Matched By gift to the employee, even when the ledger has it above $0', async () => {
    const h = harness({
      ledger: [gift('g1', '13', 10_000), gift('m1', '11', 30_000, { giftType: 'Matching Donation' })],
      donations: [donation('m1', { giftType: 'Matching Donation', matchedByItemIds: ['31'], amountCents: 0, donorItemIds: ['11'] })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] },
    });
    const report = await runRollCall(h.deps, NOW);
    expect((report.detail as { rows: number }).rows).toBe(1);
    expect(h.writes).toEqual(['group FY2027 (in progress)', 'create Ada Park']);
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

describe('runRollCall: Recognition Fiscal Year and in-kind (spec §10)', () => {
  const FY26 = [{ id: 'c26', title: 'FY2026' }, { id: 'cur', title: 'FY2027 (in progress)' }];

  it('credits an archived FY2025 gift to FY2026 through its kept credits row, read from the ledger by id', async () => {
    // Zoox's case: paid 2025-02-17 for 2026 BTWD, so FY2025 and archived. Staff restored it, set
    // 2026, and it was archived again: Donations no longer shows it, only the kept row does.
    const h = harness({
      ledger: [gift('zoox', '31', 500_000, { fiscalYear: 2025 }), gift('other25', '31', 70_000, { fiscalYear: 2025 })],
      donations: [donation('x', { donorItemIds: ['13'] })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] }, groups: FY26,
    });
    h.credits.set('zoox', { giftItemId: 'zoox', fiscalYear: 2025, recognitionFiscalYear: 2026, amountCents: 500_000, status: 'Received',
      giftType: 'Sponsorship', credit: null, unmatchedMatch: false, archivedAt: '2026-11-04T00:00:00Z' });
    const report = await runRollCall(h.deps, NOW);
    expect(report.ok).toBe(true);
    expect(report.detail).toMatchObject({ pendingLedger: 0 });
    // Only the overridden gift: other25 stays in FY2025, which the board doesn't cover.
    expect(h.created).toEqual([expect.objectContaining({ groupId: 'c26', name: 'Acme Foundation',
      values: expect.objectContaining({ rk: '2026|item:31', to: '5000.00', gi: '1', tr: { label: '$5,000+' } }) })]);
  });

  it('counts an active FY2027 gift moved to FY2026 once, in FY2026 only', async () => {
    // Walkup Melodia's case: an active FY2027 gift for a FY2026 event. Acme also gave in 2027.
    const h = harness({
      ledger: [gift('wm', '31', 150_000), gift('acme27', '31', 20_000)],
      donations: [donation('wm', { donorItemIds: ['31'], amountCents: 150_000, recognitionFiscalYear: 'FY2026' }),
        donation('acme27', { donorItemIds: ['31'], amountCents: 20_000 })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] }, groups: FY26,
    });
    await runRollCall(h.deps, NOW);
    const byKey = new Map(h.created.map((c) => [c.values.rk, c.values]));
    expect(byKey.get('2026|item:31')).toMatchObject({ to: '1500.00', gi: '1' });
    expect(byKey.get('2027|item:31')).toMatchObject({ to: '200.00', gi: '1' });
    expect(h.credits.get('wm')).toMatchObject({ credit: null, fiscalYear: 2027, recognitionFiscalYear: 2026 });
  });

  it('moves an anonymous gift\'s year without naming its donor', async () => {
    const h = harness({
      ledger: [gift('a1', '13', 5_000)],
      donations: [donation('a1', { anonymous: true, donorItemIds: ['13'], amountCents: 5_000, recognitionFiscalYear: '2026' })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] }, groups: FY26,
    });
    await runRollCall(h.deps, NOW);
    expect(h.created.map((c) => [c.groupId, c.name, c.values.rk])).toEqual([['c26', 'Anonymous', '2026|anonymous']]);
  });

  it('holds a gift moved to a future year until that year begins', async () => {
    const h = harness({
      ledger: [gift('pre', '31', 100_000)],
      donations: [donation('pre', { donorItemIds: ['31'], amountCents: 100_000, recognitionFiscalYear: '2028' })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] }, groups: FY26,
    });
    const report = await runRollCall(h.deps, NOW);
    expect((report.detail as { rows: number }).rows).toBe(0);
    expect(h.created).toEqual([]);
  });

  it('counts the In-Kind Value of a gift with no Amount (Lumos), from the duty\'s own read', async () => {
    const h = harness({
      ledger: [gift('lumos', '31', 0)],
      donations: [donation('lumos', { donorItemIds: ['31'], amountCents: null, inKindValueCents: 200_000 })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] }, groups: FY26,
    });
    await runRollCall(h.deps, NOW);
    expect(h.created.map((c) => [c.values.rk, c.values.to])).toEqual([['2027|item:31', '2000.00']]);
  });

  it('reports an unreadable Recognition Fiscal Year and counts the gift in its own year', async () => {
    const h = harness({
      ledger: [gift('g1', '13', 10_000)],
      donations: [donation('g1', { donorItemIds: ['13'], recognitionFiscalYear: 'FY26' })],
      boards: { 201: PEOPLE, 300: ORGS, 900: [] }, groups: FY26,
    });
    const report = await runRollCall(h.deps, NOW);
    expect(report.summary).toMatch(/1 gift has a Recognition Fiscal Year that isn't a year \(counted in their own year\): g1/);
    expect(h.created.map((c) => c.values.rk)).toEqual(['2027|item:13']);
  });

  it('writes Household Name with the item name when configured', async () => {
    const h = harness({
      rollCall: { ...ROLL_CALL, columns: { ...COLS, householdName: 'hn' } },
      ledger: [gift('g1', '11', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: [] }, groups: FY26,
    });
    await runRollCall(h.deps, NOW);
    expect(h.created[0]).toMatchObject({ name: 'Pat & Sam Lee', values: { hn: 'Pat & Sam Lee' } });
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

  // FY2025 is frozen with firstFiscalYear 2025, so these rows stay put unless duplicated.
  const frozen = (n: number, from = 5000) => Array.from({ length: n }, (_, i) =>
    item(String(from + i), `Kept ${i}`, { rk: `2025|item:y${i}` }, { groupId: 'old' }));
  const withFrozen = { ...ROLL_CALL, firstFiscalYear: 2025 };
  const frozenGroups = [...groups, { id: 'old', title: 'FY2025' }];

  it('counts duplicate deletes toward the limit along with gone ones', async () => {
    // 6 genuine duplicates (same key, another id) + 5 gone = 11 deletes, over the floor of 10.
    const dups = frozen(6).map((it) => ({ ...it, id: String(Number(it.id) + 100) }));
    const board = [...frozen(6), ...dups, ...stale(5)];
    const h = harness({ rollCall: withFrozen, ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: board }, groups: frozenGroups });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = await runDuty('rollcall', h.deps);
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/11 rows would be deleted, more than the limit of 10/);
    expect(h.writes).toEqual([]);

    const forced = harness({ rollCall: withFrozen, ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: board }, groups: frozenGroups });
    expect((await runDuty('rollcall', forced.deps, { force: true })).ok).toBe(true);
    expect(forced.writes.filter((w) => w.startsWith('delete')).sort())
      .toEqual([...dups.map((d) => `delete ${d.id}`), ...stale(5).map((d) => `delete ${d.id}`)].sort());
  });

  it('takes the 10% limit from distinct board items, so a repeated page neither raises it nor deletes kept rows', async () => {
    // 100 distinct items (89 frozen, 11 gone), every one read twice: 11 > 10% of 100.
    const once = [...frozen(89), ...stale(11)];
    const h = harness({ rollCall: withFrozen, ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: [...once, ...once] },
      groups: frozenGroups });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = await runDuty('rollcall', h.deps);
    expect(report.ok).toBe(false);
    expect(report.summary).toMatch(/11 rows would be deleted, more than the limit of 10/);
    expect(h.writes).toEqual([]);

    const forced = harness({ rollCall: withFrozen, ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: [...once, ...once] },
      groups: frozenGroups });
    await runDuty('rollcall', forced.deps, { force: true });
    expect(forced.writes.filter((w) => w.startsWith('delete')).sort()).toEqual(stale(11).map((d) => `delete ${d.id}`).sort());
  });

  it('force applies anyway', async () => {
    const h = harness({ ledger: [gift('g1', '13', 10_000)], boards: { 201: PEOPLE, 300: ORGS, 900: stale(11) }, groups });
    const report = await runDuty('rollcall', h.deps, { force: true });
    expect(report.ok).toBe(true);
    expect(h.writes.filter((w) => w.startsWith('delete'))).toHaveLength(11);
    expect(h.writes).toContain('create Ada Park');
  });
});
