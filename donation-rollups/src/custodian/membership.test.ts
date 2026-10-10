import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { runMembership } from './membership';
import type { CustodianDeps, CustodianMondayClient } from './custodian';
import { D1GiftsStore } from '../db/gifts';
import { D1PendingStore } from '../db/pending';
import { D1VolunteerActivityStore } from '../db/volunteerActivity';
import { D1OwnerRecomputesStore } from '../db/ownerRecomputes';
import type { DonationRollupsConfig, RecomputeQueueMessage } from '../types';

const MEMBERSHIP = { status: 'ms', tier: 'mt', since: 'msince', until: 'muntil', currentTermStart: 'mcts', memberType: 'mtype', lapseCount: 'mlc', lastLapsed: 'mll' };
const OWNER_COLS = { giftLedgerJson: 'c', lifetimeGiving: 'c', giftCount: 'c', firstGift: 'c', thisYearAmount: 'c', thisYearCount: 'c',
  lastYearAmount: 'c', lastYearCount: 'c', largestGift: 'c', smallestGift: 'c', averageGift: 'c', lastGiftDate: 'c', lastGiftAmount: 'c' };
const VOL_BOARD = { boardId: 7, columns: { attendee: 'att', event: 'ev', attendance: 'atd', role: 'role', hours: null as string | null },
  eventBoard: { boardId: 8, columns: { start: 'start' } }, volunteerRoleLabels: ['Volunteer'], countedAttendanceLabels: ['Attended'] };
const HIST_BOARD = { boardId: 9, columns: { volunteer: 'vol', date: 'dt', hours: 'hrs', status: 'st' }, countedStatusLabels: ['Completed'] };

function config(): DonationRollupsConfig {
  return {
    monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
    fiscalYear: { startMonth: 7, timeZone: 'America/Los_Angeles' },
    custodian: { activeFiscalYears: 2, workspaceId: 1, capacityAlertPct: 80, alertItemId: null, annualSummaryBoardId: null, annualSummaryColumns: null },
    affiliations: null,
    donationRollups: {
      donationBoards: [{ boardId: 100, columns: { donorLink: 'd', amount: 'a', date: 'dt', status: 's', fiscalYear: null, giftType: 'gt', termStart: 'ts', termEnd: 'te', membershipType: 'mty', actingForLink: null, classification: null } }],
      receivedStatusLabel: 'Received',
      ownerColumnsByBoard: { '20': { ...OWNER_COLS, membership: MEMBERSHIP }, '28': { ...OWNER_COLS, membership: MEMBERSHIP }, '13': OWNER_COLS },
      membership: { fromISO: '2026-10-16', eligibleGiftTypes: ['Donation'], minAmountCents: 100, termMonths: 13, lifetimeThresholdCents: 100000,
        statusLabels: { active: 'Active', lapsed: 'Lapsed' }, tierLabels: { member: 'Member', lifetime: 'Lifetime' },
        typeLabels: { new: 'New', continuing: 'Continuing', lapsedRenewal: 'Lapsed renewal', lifetime: 'Lifetime' } },
      donorLevel: null, volunteerBoards: [VOL_BOARD], historicalVolunteerBoards: [HIST_BOARD],
    },
  };
}

interface Fake {
  // board id -> items with column text, as pageItemsColumnsText pages them (one page)
  pages?: Record<string, { id: string; text: Record<string, string | null> }[]>;
  registrations?: { id: string; attendeeItemId: string | null; eventItemId: string | null; attendanceLabel: string | null; roleLabel: string | null; hours: number | null }[];
  shifts?: { id: string; volunteerItemId: string | null; dateISO: string | null; hours: number | null; statusLabel: string | null }[];
  boardOf?: Record<string, string>;
  columnText?: Record<string, Record<string, string | null>>;
}
function fakeClient(f: Fake): CustodianMondayClient {
  return {
    async archiveItem() {}, async listWorkspaceBoards() { return []; }, async createUpdate() {}, async createItem() { return 'x'; }, async changeColumnValues() {},
    async pageItemsColumnsText(boardId, columnIds) {
      const items = (f.pages?.[String(boardId)] ?? []).map((i) => ({ id: i.id, text: new Map(columnIds.map((c) => [c, i.text[c] ?? null])) }));
      return { items, cursor: null };
    },
    async getItemsColumnsText(ids, columnIds) {
      const out = new Map<string, Map<string, string | null>>();
      for (const id of ids) { const rec = f.columnText?.[id]; if (rec) out.set(id, new Map(columnIds.map((c) => [c, rec[c] ?? null]))); }
      return out;
    },
    async pageRegistrations() { return { items: f.registrations ?? [], cursor: null }; },
    async pageHistoricalShifts() { return { items: f.shifts ?? [], cursor: null }; },
    async getItemsBoardIds(ids) { return new Map(ids.flatMap((id) => (f.boardOf?.[id] ? [[id, f.boardOf[id]!] as [string, string]] : []))); },
  };
}
function deps(f: Fake, sent: RecomputeQueueMessage[], now = new Date('2027-12-03T10:00:00Z')): CustodianDeps {
  return { gifts: new D1GiftsStore(env.DB), pending: new D1PendingStore(env.DB), volunteers: new D1VolunteerActivityStore(env.DB),
    recomputes: new D1OwnerRecomputesStore(env.DB), mondayClient: fakeClient(f),
    queue: { sendBatch: async (m) => { sent.push(...m); } }, config: config(), now };
}

describe('membership duty — nightly anniversaries', () => {
  it('enqueues owner-keyed recomputes for people whose Current Term Start anniversary is today or yesterday', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({ pages: { '20': [
      { id: 'today', text: { mcts: '2026-11-03' } }, { id: 'yesterday', text: { mcts: '2026-11-02' } },
      { id: 'tomorrow', text: { mcts: '2026-11-04' } }, { id: 'blank', text: { mcts: null } } ],
      '28': [{ id: 'hist-today', text: { mcts: '2026-11-03 00:00' } }] } }, sent);
    const report = await runMembership(d, d.now!, { all: false, since: null }, null);
    expect(report.ok).toBe(true);
    expect(sent.map((m) => [m.ownerItemId, m.ownerBoardId])).toEqual([['today', '20'], ['yesterday', '20'], ['hist-today', '28']]);
    expect(sent[0]).toEqual({ donationItemId: 'custodian:membership', donationBoardId: '', ownerItemId: 'today', ownerBoardId: '20' });
    expect(report.detail).toMatchObject({ all: false, phase: 'anniversaries', enqueued: 3, scanned: 5, remaining: 0 });
  });
  it('is a no-op with a report when the membership block is null', async () => {
    const sent: RecomputeQueueMessage[] = [];
    const d = deps({}, sent);
    d.config.donationRollups.membership = null;
    const report = await runMembership(d, d.now!, { all: false, since: null }, null);
    expect(report.ok).toBe(true);
    expect(sent).toEqual([]);
  });
});
