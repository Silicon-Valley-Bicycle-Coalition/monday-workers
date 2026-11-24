// The donor stewardship emails (docs/superpowers/specs/2026-11-19-monday-stewardship-sequences-design.md):
// two welcome emails and three renewal reminders, sent by monday CRM Sequences. Monday enrolls a
// person when their 🔒 Stewardship Email status changes to a Sequence's label; this decides, once a
// day, which label each person on People should now carry.
//
// The label is also the state: it records the last email set for this person, so a stage is set
// once and a missed day is caught up (within catchUpDays) without sending anything twice. A renewal
// label is cleared once the person renews, so next year's reminders start fresh.
//
// Pure: no I/O. Mailchimp's opt-outs are checked by the run, only for the people planned here.
import { daysUntil } from '../renewalDue/plan';

export interface StewardshipLabels {
  welcomeDayAfter: string;
  welcome3Weeks: string;
  renewal3Weeks: string;
  renewal1Week: string;
  renewalDayOf: string;
}

export interface StewardshipPerson {
  itemId: string;
  email: string;
  // The Stewardship Email label now ('' when blank).
  label: string;
  membershipStatus: string;
  membershipTier: string;
  memberType: string;
  memberSince: string; // YYYY-MM-DD or ''
  memberUntil: string; // YYYY-MM-DD or ''
  hasActiveRecurringGift: boolean;
  doNotSolicit: boolean;
}

export interface StewardshipPlanOptions {
  // Today in SVBC's time zone, YYYY-MM-DD.
  today: string;
  labels: StewardshipLabels;
  activeStatusValue: string;
  lifetimeTierValue: string;
  newMemberTypeValue: string;
  // How many days late a stage may still be set, after a failed or skipped run.
  catchUpDays: number;
  // Months to send the renewal reminders ahead of Member Until; 0 counts from Member Until itself.
  renewalMonthsEarly: number;
}

// 'clear' blanks a renewal label after a renewal; it enrolls nothing.
export type StewardshipKind = 'welcome' | 'renewal' | 'clear';

export interface StewardshipWrite {
  itemId: string;
  email: string;
  label: string;
  kind: StewardshipKind;
}

export interface StewardshipPlan {
  writes: StewardshipWrite[];
}

// Days before the reminder date (Member Until less renewalMonthsEarly) each renewal reminder goes,
// in sending order.
const RENEWAL_DAYS = [21, 7, 0] as const;
// Days after Member Since each welcome email goes.
const WELCOME_DAYS = [1, 21] as const;

// `date` (YYYY-MM-DD) less `months`, on the last day of the month when that month is shorter.
// Anything else passes through, for daysUntil to reject.
function monthsBefore(date: string, months: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m - months, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 - months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

function renewalStages(labels: StewardshipLabels): string[] {
  return [labels.renewal3Weeks, labels.renewal1Week, labels.renewalDayOf];
}

function planRenewal(p: StewardshipPerson, o: StewardshipPlanOptions): StewardshipWrite | null {
  const stages = renewalStages(o.labels);
  const current = stages.indexOf(p.label);
  const days = daysUntil(monthsBefore(p.memberUntil, o.renewalMonthsEarly), o.today);
  if (Number.isNaN(days)) return null;
  // Renewed (the date moved past the first reminder): start the next cycle from a blank label.
  if (current >= 0 && days > RENEWAL_DAYS[0]) return { itemId: p.itemId, email: p.email, label: '', kind: 'clear' };
  if (p.email === '' || p.doNotSolicit || p.hasActiveRecurringGift) return null;
  if (p.membershipStatus !== o.activeStatusValue || p.membershipTier === o.lifetimeTierValue) return null;
  for (let s = 0; s < RENEWAL_DAYS.length; s += 1) {
    const due = RENEWAL_DAYS[s]!;
    if (days <= due && days >= Math.max(0, due - o.catchUpDays)) {
      return s > current ? { itemId: p.itemId, email: p.email, label: stages[s]!, kind: 'renewal' } : null;
    }
  }
  return null;
}

function planWelcome(p: StewardshipPerson, o: StewardshipPlanOptions): StewardshipWrite | null {
  if (p.email === '' || p.doNotSolicit || p.memberType !== o.newMemberTypeValue) return null;
  const since = -daysUntil(p.memberSince, o.today);
  if (Number.isNaN(since)) return null;
  const inWindow = (due: number) => since >= due && since <= due + o.catchUpDays;
  if (p.label === '' && inWindow(WELCOME_DAYS[0])) return { itemId: p.itemId, email: p.email, label: o.labels.welcomeDayAfter, kind: 'welcome' };
  // The second only follows the first: someone who joined before launch gets neither.
  if (p.label === o.labels.welcomeDayAfter && inWindow(WELCOME_DAYS[1])) return { itemId: p.itemId, email: p.email, label: o.labels.welcome3Weeks, kind: 'welcome' };
  return null;
}

export function planStewardship(people: readonly StewardshipPerson[], o: StewardshipPlanOptions): StewardshipPlan {
  const writes: StewardshipWrite[] = [];
  for (const p of people) {
    const write = planRenewal(p, o) ?? planWelcome(p, o);
    if (write !== null) writes.push(write);
  }
  return { writes };
}
