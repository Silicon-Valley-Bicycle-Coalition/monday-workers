// The Salesforce Create_members flow, in Monday terms — spec §"The rule, in Monday terms".
// Everything here is pure: the consumer feeds it the baseline, the owner's gifts, and today's
// date, and writes back only what changed. Keep it that way; the idempotency argument in the
// spec depends on this module having no I/O and no clock.
import type { MembershipConfig, OwnerMembershipColumns } from '../types';

export type Tier = 'member' | 'lifetime';
export type TermType = 'new' | 'renewal' | 'reacquire' | 'lifetime';

export interface MembershipState {
  since: string | null; // ISO date
  until: string | null; // ISO date; null for Lifetime and for never-members
  tier: Tier | null;
}

export interface MembershipGift {
  id: string;
  dateISO: string; // '' when unknown
  amountCents: number;
  status: string;
  giftType: string | null;
}

export interface GiftTerm {
  start: string;
  end: string | null; // null for Lifetime
  type: TermType;
}

export interface DerivedMembership {
  state: MembershipState;
  terms: Map<string, GiftTerm>; // gift item id -> its term; absent = no term for this gift
}

// What the owner board currently holds, as read — statusLabel is the raw label text so the
// changed-only write can compare it without re-deriving.
export interface BoardMembership extends MembershipState {
  statusLabel: string | null;
}

export const EMPTY_STATE: MembershipState = { since: null, until: null, tier: null };

const pad = (n: number): string => String(n).padStart(2, '0');

// Calendar month arithmetic on a plain ISO date. Day overflow (Feb 29 → a non-leap year,
// Jan 31 + 1 month) rolls forward into the next month, which for the one case Salesforce's
// OneYearFromClose formula handles (Feb 29) yields the same Mar 1.
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (d <= daysInMonth) return `${year}-${pad(month)}-${pad(d)}`;
  const next = new Date(Date.UTC(year, month, 1)); // month is 1-based here, so this is the 1st of the following month
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`;
}

export function isEligibleGift(g: MembershipGift, config: MembershipConfig, receivedStatusLabel: string): boolean {
  return g.status === receivedStatusLabel
    && g.giftType !== null && config.eligibleGiftTypes.includes(g.giftType)
    && /^\d{4}-\d{2}-\d{2}/.test(g.dateISO) && g.dateISO.slice(0, 10) >= config.fromISO;
}

const minDate = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : (a < b ? a : b);
const maxDate = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : (a > b ? a : b);

export function deriveMembership(
  baseline: MembershipState, gifts: MembershipGift[], config: MembershipConfig, receivedStatusLabel: string,
): DerivedMembership {
  const eligible = gifts
    .filter((g) => isEligibleGift(g, config, receivedStatusLabel))
    .sort((a, b) => (a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let state: MembershipState = { ...baseline };
  const terms = new Map<string, GiftTerm>();
  for (const g of eligible) {
    if (state.tier === 'lifetime') continue; // the flow's "Already a life member" exit
    const start = g.dateISO.slice(0, 10);
    if (g.amountCents >= config.lifetimeThresholdCents) {
      terms.set(g.id, { start, end: null, type: 'lifetime' });
      state = { since: minDate(state.since, start), until: null, tier: 'lifetime' };
      continue;
    }
    const end = addMonths(start, config.termMonths);
    const type: TermType = state.since === null ? 'new'
      : (state.until !== null && state.until < start) ? 'reacquire'
      : 'renewal';
    terms.set(g.id, { start, end, type });
    state = { since: minDate(state.since, start), until: maxDate(state.until, end), tier: 'member' };
  }
  return { state, terms };
}

// Extend-only (spec §"Merge with the board"): the integration never shortens or downgrades.
export function mergeWithBoard(derived: MembershipState, board: MembershipState): MembershipState {
  const tier: Tier | null = derived.tier === 'lifetime' || board.tier === 'lifetime' ? 'lifetime'
    : derived.tier ?? board.tier;
  return {
    since: minDate(derived.since, board.since),
    until: tier === 'lifetime' ? null : maxDate(derived.until, board.until),
    tier,
  };
}

export function statusFor(state: MembershipState, todayISO: string): 'active' | 'lapsed' | null {
  if (state.tier === null && state.since === null && state.until === null) return null;
  if (state.tier === 'lifetime') return 'active';
  return state.until !== null && state.until >= todayISO ? 'active' : 'lapsed';
}

export function tierFromLabel(label: string | null, config: MembershipConfig): Tier | null {
  if (label === null || label === '') return null;
  return label === config.tierLabels.lifetime ? 'lifetime' : 'member';
}

const dateCol = (iso: string | null): unknown => (iso === null ? null : { date: iso });

export function membershipColumnValues(
  merged: MembershipState, status: 'active' | 'lapsed' | null, board: BoardMembership,
  columns: OwnerMembershipColumns, config: MembershipConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (status === null) return out; // never a member anywhere — leave the blanks alone
  const statusLabel = config.statusLabels[status];
  if (statusLabel !== board.statusLabel) out[columns.status] = { label: statusLabel };
  if (merged.tier !== board.tier && merged.tier !== null) out[columns.tier] = { label: config.tierLabels[merged.tier] };
  if (merged.since !== board.since) out[columns.since] = dateCol(merged.since);
  if (merged.until !== board.until) out[columns.until] = dateCol(merged.until);
  return out;
}

export function termColumnValues(
  term: GiftTerm | undefined,
  current: { termStart: string | null; termEnd: string | null; membershipType: string | null },
  columns: { termStart: string; termEnd: string; membershipType: string },
  config: MembershipConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (term === undefined) return out;
  if (term.start !== current.termStart) out[columns.termStart] = dateCol(term.start);
  if (term.end !== current.termEnd) out[columns.termEnd] = dateCol(term.end);
  const typeLabel = config.typeLabels[term.type];
  if (typeLabel !== current.membershipType) out[columns.membershipType] = typeLabel;
  return out;
}
