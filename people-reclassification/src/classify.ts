// The liveness rule, as pure functions over what a pass read from the boards.
//
// Mirrors salesforce-import's classifyContact (src/transform/people.ts) and the sizing script
// monday-migration/scripts/analyze-people-rolling-window.mjs, with the fixed peopleActiveSinceISO
// cutoff replaced by a window of `years` ending today:
//   perpetual (never ages out): a linked Funraise supporter profile; Membership Tier = Lifetime.
//   activity dates: Last Gift Date; Member Until; a counted event registration's event start; a
//     volunteer-hours date; a logged item on Activities (Logged); Promoted On,
//     which staff set by promoting someone (src/promote.ts). A date after today is a data-entry defect (docs/07's CloseDate
//     finding) and is ignored — except Member Until, where "after today" is just a current term.
//   no evidence at all: left where it is, and counted. Moving on absence would sweep advocacy
//     contacts (Stakeholder Type = City or Agency Staff, Elected Official) and anyone staff add
//     by hand off the live board, since none of those leave a gift, term or registration behind.
// The imported Activities board (classifyContact's recentActivityIds) is not a source here: the
// sizing analysis left it out too, and it holds two years of staff Tasks, inside any window.

export type Board = 'live' | 'historical';

export interface PersonFacts {
  itemId: string;
  board: Board;
  lastGiftISO: string | null;
  memberUntilISO: string | null;
  membershipTier: string | null;
  funraiseLinked: boolean;
  latestRegistrationISO: string | null;
  latestVolunteerISO: string | null;
  latestLoggedISO: string | null;
  promotedOnISO: string | null;
}

export type Verdict =
  | { kind: 'live'; reason: 'funraise-linked' | 'lifetime-member' | 'current-member' | 'recent-activity'; latestActivity: string | null }
  | { kind: 'historical'; reason: 'aged-out'; latestActivity: string }
  | { kind: 'unknown'; reason: 'no-evidence'; latestActivity: null };

export interface RuleOptions { todayISO: string; cutoffISO: string; lifetimeTierLabel: string; funraiseLinked: boolean }

const DATE = /^\d{4}-\d{2}-\d{2}/;
export const dateOnly = (v: string | null | undefined): string | null => (v && DATE.test(v) ? v.slice(0, 10) : null);

export function latestActivity(p: PersonFacts, todayISO: string): string | null {
  // Member Until is clamped to today rather than dropped: a term ending next year is current
  // engagement, not a defect, and it must not outrank a later real date either way.
  const until = dateOnly(p.memberUntilISO);
  const candidates = [
    dateOnly(p.lastGiftISO), dateOnly(p.latestRegistrationISO), dateOnly(p.latestVolunteerISO),
    dateOnly(p.latestLoggedISO), dateOnly(p.promotedOnISO),
    until === null ? null : until > todayISO ? todayISO : until,
  ].filter((d): d is string => d !== null && d <= todayISO);
  return candidates.length === 0 ? null : candidates.reduce((a, b) => (a > b ? a : b));
}

export function classify(p: PersonFacts, opts: RuleOptions): Verdict {
  if (opts.funraiseLinked && p.funraiseLinked) return { kind: 'live', reason: 'funraise-linked', latestActivity: null };
  if (p.membershipTier === opts.lifetimeTierLabel) return { kind: 'live', reason: 'lifetime-member', latestActivity: null };
  const until = dateOnly(p.memberUntilISO);
  if (until !== null && until > opts.todayISO) return { kind: 'live', reason: 'current-member', latestActivity: opts.todayISO };
  const latest = latestActivity(p, opts.todayISO);
  if (latest === null) return { kind: 'unknown', reason: 'no-evidence', latestActivity: null };
  return latest >= opts.cutoffISO
    ? { kind: 'live', reason: 'recent-activity', latestActivity: latest }
    : { kind: 'historical', reason: 'aged-out', latestActivity: latest };
}

// Today as YYYY-MM-DD in the configured zone, so a pass at 02:00 Pacific doesn't count as the
// next day (donation-rollups learned this the hard way with This Year rolling at 5pm).
export function todayInZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// The window's start: the same month and day `years` earlier (Feb 29 → Feb 28).
export function cutoffFor(todayISO: string, years: number): string {
  const [y, m, d] = todayISO.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y - years, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y - years, m, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, daysInMonth));
  return target.toISOString().slice(0, 10);
}
