// The membership activity rule, in Monday terms — spec 2026-10-09 "The rule, in Monday terms".
// Everything here is pure: the consumer feeds it the owner's gifts (from the ledger), their
// volunteer check-ins (from D1), the config and today's date, and writes back only what
// changed. Keep it that way; the idempotency argument depends on this module having no I/O.
import type { MembershipConfig, OwnerMembershipColumns } from '../types';
import type { VolunteerActivityRow } from '../db/volunteerActivity';

export type Tier = 'member' | 'lifetime';
export type TermType = 'new' | 'continuing' | 'lapsedRenewal' | 'lifetime';
export type MemberType = 'new' | 'continuing' | 'lapsedRenewal';
export type ActivityKind = 'gift' | 'migrated-term' | 'volunteer';

export interface MembershipActivity { id: string; kind: ActivityKind; dateISO: string; lifetime: boolean }

export interface MembershipGift {
  id: string;
  dateISO: string;            // '' when unknown
  amountCents: number;
  status: string;
  giftType: string | null;
  termStart: string | null;   // migrated Term Start; null = not read, '' = read, blank
}

export interface Run { start: string; end: string; activities: number }

export interface OwnerMembershipState {
  since: string | null;
  currentTermStart: string | null;
  until: string | null;        // null for Lifetime
  tier: Tier | null;
  lapseCount: number;
  lastLapsed: string | null;
  memberType: MemberType | null;
}

export interface GiftTerm { start: string; end: string | null; type: TermType }

export interface DerivedMembership {
  state: OwnerMembershipState | null;   // null = no qualifying activity at all; leave the board alone
  terms: Map<string, GiftTerm>;         // post-fromISO gift item id -> its stamp
}

export interface BoardMembership {
  statusLabel: string | null; tierLabel: string | null; since: string | null; until: string | null;
  currentTermStart: string | null; memberTypeLabel: string | null; lapseCount: number | null; lastLapsed: string | null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

// Calendar month arithmetic on a plain ISO date. Day overflow rolls forward into the 1st of
// the next month, which for Feb 29 matches Salesforce's old OneYearFromClose formula.
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  const total = (m - 1) + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (d <= daysInMonth) return `${year}-${pad(month)}-${pad(d)}`;
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-01`;
}

const isISODate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}/.test(s);

// "Given at least $1": Received, Gift Type in the list, amount at/over the floor, dated.
// No date gate — a qualifying gift counts whenever it happened; fromISO only decides stamping.
export function isQualifyingGift(g: MembershipGift, config: MembershipConfig, receivedStatusLabel: string): boolean {
  return g.status === receivedStatusLabel
    && g.giftType !== null && config.eligibleGiftTypes.includes(g.giftType)
    && g.amountCents >= config.minAmountCents
    && isISODate(g.dateISO);
}

const KIND_ORDER: Record<ActivityKind, number> = { gift: 0, 'migrated-term': 1, volunteer: 2 };
const byDateKindId = (a: MembershipActivity, b: MembershipActivity): number =>
  a.dateISO < b.dateISO ? -1 : a.dateISO > b.dateISO ? 1
  : KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function activitiesFor(
  gifts: MembershipGift[], volunteers: VolunteerActivityRow[], config: MembershipConfig, receivedStatusLabel: string,
): MembershipActivity[] {
  const out: MembershipActivity[] = [];
  for (const g of gifts) {
    if (isQualifyingGift(g, config, receivedStatusLabel)) {
      out.push({ id: g.id, kind: 'gift', dateISO: g.dateISO.slice(0, 10), lifetime: g.amountCents >= config.lifetimeThresholdCents });
    } else if (isISODate(g.dateISO) && g.dateISO.slice(0, 10) < config.fromISO && g.termStart !== null && isISODate(g.termStart)) {
      // Migrated history is trusted as stamped: comps and $0 membership terms were memberships.
      out.push({ id: g.id, kind: 'migrated-term', dateISO: g.termStart.slice(0, 10), lifetime: false });
    }
  }
  for (const v of volunteers) {
    if (v.qualifies && v.activityDateISO !== null && isISODate(v.activityDateISO)) {
      out.push({ id: v.registrationItemId, kind: 'volunteer', dateISO: v.activityDateISO.slice(0, 10), lifetime: false });
    }
  }
  return out.sort(byDateKindId);
}

// Each activity reaches termMonths ahead; one dated on or before the current run's end
// extends it, one dated after starts the next run. Input must already be sorted.
export function buildRuns(activities: MembershipActivity[], termMonths: number): Run[] {
  const runs: Run[] = [];
  for (const a of activities) {
    const current = runs.at(-1);
    if (current !== undefined && a.dateISO <= current.end) {
      current.end = addMonths(a.dateISO, termMonths);
      current.activities += 1;
    } else {
      runs.push({ start: a.dateISO, end: addMonths(a.dateISO, termMonths), activities: 1 });
    }
  }
  return runs;
}

// Continuing from the anniversary of the current run's start — and only if the run was
// re-qualified before then (its end is past the anniversary). Without the second condition a
// one-activity run would read Continuing on the single day it is past its anniversary and still
// Active (Until = anniversary). Otherwise New or Lapsed renewal by whether an earlier run exists.
export function memberTypeFor(run: Run, lapseCount: number, todayISO: string, termMonths: number): MemberType {
  const anniversary = addMonths(run.start, termMonths);
  if (todayISO >= anniversary && run.end > anniversary) return 'continuing';
  return lapseCount === 0 ? 'new' : 'lapsedRenewal';
}

export function deriveMembership(
  gifts: MembershipGift[], volunteers: VolunteerActivityRow[], config: MembershipConfig, receivedStatusLabel: string, todayISO: string,
): DerivedMembership {
  const activities = activitiesFor(gifts, volunteers, config, receivedStatusLabel);
  const terms = new Map<string, GiftTerm>();
  if (activities.length === 0) return { state: null, terms };

  // Walk once: build runs and, for each post-fromISO gift, note whether it opened a run.
  const runs: Run[] = [];
  let lifetime = false;
  for (const a of activities) {
    const current = runs.at(-1);
    const opensRun = current === undefined || a.dateISO > current.end;
    if (opensRun) runs.push({ start: a.dateISO, end: addMonths(a.dateISO, config.termMonths), activities: 1 });
    else { current!.end = addMonths(a.dateISO, config.termMonths); current!.activities += 1; }

    if (a.kind === 'gift' && a.dateISO >= config.fromISO && !lifetime) {
      if (a.lifetime) terms.set(a.id, { start: a.dateISO, end: null, type: 'lifetime' });
      else {
        const type: TermType = opensRun ? (runs.length === 1 ? 'new' : 'lapsedRenewal') : 'continuing';
        terms.set(a.id, { start: a.dateISO, end: addMonths(a.dateISO, config.termMonths), type });
      }
    }
    if (a.lifetime) lifetime = true;
  }

  const current = runs.at(-1)!;
  const lapseCount = runs.length - 1;
  return {
    state: {
      since: runs[0]!.start,
      currentTermStart: current.start,
      until: lifetime ? null : current.end,
      tier: lifetime ? 'lifetime' : 'member',
      lapseCount,
      lastLapsed: lapseCount > 0 ? runs[lapseCount - 1]!.end : null,
      memberType: memberTypeFor(current, lapseCount, todayISO, config.termMonths),
    },
    terms,
  };
}

const minDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a < b ? a : b);
const maxDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

// Since only ever earlier, Until only ever later, Tier never down; the rest are derived facts
// the board does not get a vote on (spec "Merge with the board").
export function mergeWithBoard(
  derived: OwnerMembershipState, board: { since: string | null; until: string | null; tier: Tier | null },
): OwnerMembershipState {
  const tier: Tier | null = derived.tier === 'lifetime' || board.tier === 'lifetime' ? 'lifetime' : derived.tier ?? board.tier;
  return {
    ...derived,
    since: minDate(derived.since, board.since),
    until: tier === 'lifetime' ? null : maxDate(derived.until, board.until),
    tier,
  };
}

export function statusFor(state: OwnerMembershipState, todayISO: string): 'active' | 'lapsed' {
  if (state.tier === 'lifetime') return 'active';
  return state.until !== null && state.until >= todayISO ? 'active' : 'lapsed';
}

export function tierFromLabel(label: string | null, config: MembershipConfig): Tier | null {
  if (label === null || label === '') return null;
  return label === config.tierLabels.lifetime ? 'lifetime' : 'member';
}

const dateCol = (iso: string | null): unknown => (iso === null ? null : { date: iso });

export function membershipColumnValues(
  merged: OwnerMembershipState, status: 'active' | 'lapsed', board: BoardMembership,
  columns: OwnerMembershipColumns, config: MembershipConfig,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const statusLabel = config.statusLabels[status];
  if (statusLabel !== board.statusLabel) out[columns.status] = { label: statusLabel };
  if (merged.tier !== null && config.tierLabels[merged.tier] !== board.tierLabel) out[columns.tier] = { label: config.tierLabels[merged.tier] };
  if (merged.since !== board.since) out[columns.since] = dateCol(merged.since);
  if (merged.until !== board.until) out[columns.until] = dateCol(merged.until);
  if (merged.currentTermStart !== board.currentTermStart) out[columns.currentTermStart] = dateCol(merged.currentTermStart);
  if (merged.memberType !== null && config.typeLabels[merged.memberType] !== board.memberTypeLabel) {
    out[columns.memberType] = { label: config.typeLabels[merged.memberType] };
  }
  if (merged.lapseCount !== board.lapseCount) out[columns.lapseCount] = String(merged.lapseCount);
  if (merged.lastLapsed !== board.lastLapsed) out[columns.lastLapsed] = dateCol(merged.lastLapsed);
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
