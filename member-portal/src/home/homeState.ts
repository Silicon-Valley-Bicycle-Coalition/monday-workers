// Which "state" a member's home page is in. Pure: no I/O, no Monday or D1 imports. Dates are
// YYYY-MM-DD calendar dates, compared as such (never as local-time instants), and "today" is the
// America/Los_Angeles calendar date.

export interface HomeConfig {
  newMemberDays: number;
  renewalWarningDays: number;
  // MM-DD: the last day (inclusive) a tax letter outranks every other state.
  taxLetterUntil: string;
}

export interface LetterSummary {
  year: number;
  // Acknowledged gifts only (LetterData.gifts), matching the letter's total; separately listed
  // gifts are not counted.
  giftCount: number;
  totalFormatted: string;
}

export interface HomePerson {
  id: string;
  firstName: string;
  status: string;
  tier: string;
  until: string;
  since: string;
  memberType: string;
  letter: LetterSummary | null;
}

export type PersonState =
  | { kind: 'taxLetter'; letter: LetterSummary }
  | { kind: 'renew'; reason: 'due' | 'lapsed' | 'never'; date: string | null }
  | { kind: 'newMember' }
  | { kind: 'default' };

// Highest priority first.
export const STATE_RANK: PersonState['kind'][] = ['taxLetter', 'renew', 'newMember', 'default'];

export interface PageState {
  kind: PersonState['kind'];
  // Everyone holding the winning kind.
  personIds: string[];
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Whole calendar days from `from` to `to` (negative when `to` is earlier), or null if either
// isn't a YYYY-MM-DD date.
function daysBetween(from: string, to: string): number | null {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) return null;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

// A membership that has ended: Lapsed, or a Member Until already past (Monday's status can lag the
// date). Never for Lifetime. Shared with the card widgets, so "Ended MM/YYYY" follows the same rule.
export function membershipEnded(p: Pick<HomePerson, 'status' | 'tier' | 'until'>, today: string): boolean {
  if (p.tier === 'Lifetime') return false;
  if (p.status === 'Lapsed') return true;
  const daysLeft = daysBetween(today, p.until.trim());
  return daysLeft !== null && daysLeft < 0;
}

export function personState(p: HomePerson, today: string, cfg: HomeConfig): PersonState {
  if (p.letter !== null && today.slice(5) <= cfg.taxLetterUntil) {
    return { kind: 'taxLetter', letter: p.letter };
  }

  // Lifetime first: a Lifetime member never gets the renew state, whatever the status says.
  if (p.tier !== 'Lifetime') {
    const until = p.until.trim();
    if (p.status === '' && p.tier === '') {
      return { kind: 'renew', reason: 'never', date: null };
    }
    if (membershipEnded(p, today)) {
      return { kind: 'renew', reason: 'lapsed', date: until === '' ? null : until };
    }
    const daysLeft = until === '' ? null : daysBetween(today, until);
    if (daysLeft !== null && daysLeft <= cfg.renewalWarningDays) {
      return { kind: 'renew', reason: 'due', date: until };
    }
  }

  if (p.memberType === 'New') {
    const age = daysBetween(p.since.trim(), today);
    if (age !== null && age <= cfg.newMemberDays) return { kind: 'newMember' };
  }

  return { kind: 'default' };
}

export function pageState(people: { person: HomePerson; state: PersonState }[]): PageState {
  const kind = STATE_RANK.find((k) => people.some((e) => e.state.kind === k)) ?? 'default';
  return { kind, personIds: people.filter((e) => e.state.kind === kind).map((e) => e.person.id) };
}

export function todayInLosAngeles(now: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
