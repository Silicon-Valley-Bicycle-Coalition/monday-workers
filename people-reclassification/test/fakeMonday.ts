import { env } from 'cloudflare:test';
import { D1Ledger } from '../src/db/ledger';
import type { PassDeps } from '../src/pass';
import type { BoardSchema, ItemsPage, PageItem, ReclassificationMondayClient } from '../src/monday/client';
import type { BoardColumn, ColumnMapping } from '../src/columns';
import type { ReclassificationConfig } from '../src/types';

// An in-memory Monday for the pass, promote and logged-contact tests.

// Fixed clock: 2026-10-09 in Los Angeles → window from 2019-10-09.
export const NOW = new Date('2026-10-09T17:00:00Z');
export const LIVE = 100;
export const HIST = 200;
export const EVENTS = 300;
export const REGS = 400;
export const VOLS = 500;
export const IT = 600;
export const LOGGED = 700;

export function config(over: Partial<ReclassificationConfig> = {}): ReclassificationConfig {
  return {
    monday: { apiUrl: 'https://x', accountUrl: 'https://acme.monday.com' },
    window: { years: 7, timeZone: 'America/Los_Angeles' },
    boards: { live: { boardId: LIVE, groupId: null }, historical: { boardId: HIST, groupId: null } },
    peopleColumns: { lastGift: 'Last Gift Date', memberUntil: 'Member Until', membershipTier: 'Membership Tier', funraiseProfile: 'Funraise Profile', promoteStatus: 'Promote to People', promotedOn: 'Promoted On' },
    perpetual: { lifetimeTierLabel: 'Lifetime', funraiseLinked: true },
    eventRegistrations: {
      boardId: REGS, columns: { attendee: 'Attendee', event: 'Event', attendance: 'Attendance', source: 'Source' },
      countedAttendanceLabels: ['Attended'], countedRegisteredSources: ['Funraise'], events: { boardId: EVENTS, startColumn: 'Date' },
    },
    volunteers: { boardId: VOLS, columns: { volunteer: 'Volunteer', date: 'Date' } },
    loggedActivities: { boardId: LOGGED, columns: { person: 'Person', date: 'Date', activityType: 'Activity Type' }, countedTypeLabels: ['Email', 'Call', 'Meeting'] },
    promote: { requestLabel: 'Promote', doneLabel: 'Promoted', failedLabel: "Couldn't promote" },
    thresholds: { itemsLimit: 10000, liveTriggerPct: 85, historicalWarnPct: 80 },
    run: { maxMovesPerRun: 400, quarterlyMonths: [1, 4, 7, 10], cronHourUTC: 10 },
    alerts: { itRequests: null },
    ...over,
  };
}

// Column ids differ per board (as on the real boards); titles agree.
export const peopleColumns = (suffix: string): BoardColumn[] => [
  { id: 'name', title: 'Name', type: 'name' },
  { id: `date_lg_${suffix}`, title: 'Last Gift Date', type: 'date' },
  { id: `date_mu_${suffix}`, title: 'Member Until', type: 'date' },
  { id: `color_mt_${suffix}`, title: 'Membership Tier', type: 'status' },
  { id: `link_fp_${suffix}`, title: 'Funraise Profile', type: 'link' },
  { id: `br_org_${suffix}`, title: 'Organization', type: 'board_relation' },
  { id: `formula_${suffix}`, title: 'Age', type: 'formula' },
  { id: `color_pp_${suffix}`, title: 'Promote to People', type: 'status' },
  { id: `date_po_${suffix}`, title: 'Promoted On', type: 'date' },
];

export interface Person { id: string; lastGift?: string; memberUntil?: string; tier?: string; funraise?: string; promotedOn?: string; promote?: string }
export interface Registration { id: string; attendees: string[]; events: string[]; attendance?: string; source?: string }

export interface FakeState {
  live: Person[];
  historical: Person[];
  liveCount?: number;
  historicalCount?: number;
  historicalColumns?: BoardColumn[];
  events?: { id: string; start?: string }[];
  registrations?: Registration[];
  volunteers?: { id: string; people: string[]; date?: string }[];
  logged?: { id: string; people?: string[]; date?: string; type?: string }[];
  itRequestsColumns?: BoardColumn[];
  moves: { itemId: string; boardId: number; groupId: string; mapping: ColumnMapping[] }[];
  failMove?: (itemId: string) => Error | null;
  created: { boardId: number; name: string; columnValues: Record<string, unknown> }[];
  writes?: { boardId: number; itemId: string; values: Record<string, unknown> }[];
  updates?: { itemId: string; body: string }[];
  failWrite?: (itemId: string, values: Record<string, unknown>) => Error | null;
  boardOf?: Record<string, string | null>;
  pageSize?: number;
}

function personItem(p: Person, suffix: string): PageItem {
  return {
    id: p.id,
    text: new Map([
      [`date_lg_${suffix}`, p.lastGift ?? null], [`date_mu_${suffix}`, p.memberUntil ?? null],
      [`color_mt_${suffix}`, p.tier ?? null], [`link_fp_${suffix}`, p.funraise ?? null],
      [`date_po_${suffix}`, p.promotedOn ?? null], [`color_pp_${suffix}`, p.promote ?? null],
    ]),
    linked: new Map(),
  };
}

export function fakeClient(state: FakeState): ReclassificationMondayClient {
  const schema = (id: number, name: string, columns: BoardColumn[], count: number): BoardSchema =>
    ({ id: String(id), name, itemsCount: count, itemsLimit: 10000, columns, groups: [{ id: `g_${id}`, title: 'Main' }] });
  const schemas: Record<number, BoardSchema> = {
    [LIVE]: schema(LIVE, 'People', peopleColumns('l'), state.liveCount ?? state.live.length),
    [HIST]: schema(HIST, 'People (Historical)', state.historicalColumns ?? peopleColumns('h'), state.historicalCount ?? state.historical.length),
    [EVENTS]: schema(EVENTS, 'Events', [{ id: 'date_start', title: 'Date', type: 'date' }], 0),
    [REGS]: schema(REGS, 'Event Registrations', [
      { id: 'br_att', title: 'Attendee', type: 'board_relation' }, { id: 'br_ev', title: 'Event', type: 'board_relation' },
      { id: 'color_at', title: 'Attendance', type: 'status' }, { id: 'color_src', title: 'Source', type: 'status' },
    ], 0),
    [VOLS]: schema(VOLS, 'Volunteers', [{ id: 'br_vol', title: 'Volunteer', type: 'board_relation' }, { id: 'date_d', title: 'Date', type: 'date' }], 0),
    [LOGGED]: schema(LOGGED, 'Activities (Logged)', [
      { id: 'br_person', title: 'Person', type: 'board_relation' }, { id: 'date_a', title: 'Date', type: 'date' },
      { id: 'color_type', title: 'Activity Type', type: 'status' },
    ], 0),
    [IT]: schema(IT, 'IT Requests', state.itRequestsColumns ?? [{ id: 'color_type', title: 'Type', type: 'status' }], 0),
  };
  const items: Record<number, PageItem[]> = {
    [LIVE]: state.live.map((p) => personItem(p, 'l')),
    [HIST]: state.historical.map((p) => personItem(p, 'h')),
    [EVENTS]: (state.events ?? []).map((e) => ({ id: e.id, text: new Map([['date_start', e.start ?? null]]), linked: new Map() })),
    [REGS]: (state.registrations ?? []).map((r) => ({
      id: r.id, text: new Map([['color_at', r.attendance ?? null], ['color_src', r.source ?? null]]),
      linked: new Map([['br_att', r.attendees], ['br_ev', r.events]]),
    })),
    [VOLS]: (state.volunteers ?? []).map((v) => ({ id: v.id, text: new Map([['date_d', v.date ?? null]]), linked: new Map([['br_vol', v.people]]) })),
    [LOGGED]: (state.logged ?? []).map((a) => ({
      id: a.id, text: new Map([['date_a', a.date ?? null], ['color_type', a.type ?? null]]), linked: new Map([['br_person', a.people ?? []]]),
    })),
  };
  return {
    async getBoardSchema(boardId) { return schemas[boardId] ?? null; },
    async pageItems(boardId, _columnIds, cursor): Promise<ItemsPage> {
      const all = items[boardId] ?? [];
      const size = state.pageSize ?? 500;
      const start = cursor === null ? 0 : Number(cursor);
      const page = all.slice(start, start + size);
      return { items: page, cursor: start + size < all.length ? String(start + size) : null };
    },
    async getItemBoardId(itemId) { return state.boardOf?.[itemId] ?? null; },
    async getItemValues(itemId) { return [...items[LIVE]!, ...items[HIST]!].find((i) => i.id === itemId) ?? null; },
    async moveItemToBoard(itemId, boardId, groupId, mapping) {
      const err = state.failMove?.(itemId) ?? null;
      if (err) throw err;
      state.moves.push({ itemId, boardId, groupId, mapping });
    },
    async findItemsByStatus(boardId, _columnId, label) {
      const people = boardId === LIVE ? state.live : boardId === HIST ? state.historical : [];
      return people.filter((p) => p.promote === label).map((p) => p.id);
    },
    async writeColumnValues(boardId, itemId, values) {
      const err = state.failWrite?.(itemId, values) ?? null;
      if (err) throw err;
      (state.writes ??= []).push({ boardId, itemId, values });
    },
    async postUpdate(itemId, body) { (state.updates ??= []).push({ itemId, body }); },
    async createItem(boardId, name, columnValues) {
      state.created.push({ boardId, name, columnValues });
      return `it-${state.created.length}`;
    },
  };
}

export function deps(state: FakeState, cfg = config()): PassDeps {
  return { monday: fakeClient(state), ledger: new D1Ledger(env.DB), config: cfg, now: () => NOW };
}

export const moveRows = () => env.DB.prepare('SELECT item_id, direction, status, reason, latest_activity, error FROM moves ORDER BY id').all<Record<string, unknown>>().then((r) => r.results);
