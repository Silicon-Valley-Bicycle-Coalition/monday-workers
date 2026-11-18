// The renewal-due tag (docs: README "Renewal reminders"): Mailchimp's date triggers repeat every
// year on a date field's month and day, and its segments can't test a future date, so a renewal
// Journey can't tell an upcoming expiry from an old or far-off one. Instead the daily cron keeps a
// tag on exactly the members whose renewal is due, and the Journey starts when the tag is added.
//
// Pure: no I/O. Addresses stay inside the plan; the run logs counts only.

export interface RenewalMember {
  email_address: string;
  status: string;
  merge_fields?: Record<string, unknown>;
  tags?: { name: string }[];
}

export interface RenewalDueOptions {
  activeTag: string;
  dueTag: string;
  // MEMBUNTIL's merge tag (config mailchimp.mergeFields.memberUntil).
  untilField: string;
  daysBefore: number;
  // Today's date in SVBC's time zone, YYYY-MM-DD.
  today: string;
}

export interface RenewalDuePlan {
  add: string[];
  remove: string[];
  due: number;
}

const DAY_MS = 86_400_000;

/** Whole days from `today` to `date` (both YYYY-MM-DD); NaN for anything else. */
export function daysUntil(date: string, today: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return Number.NaN;
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** Today's calendar date in `timeZone`, YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/**
 * Due = tagged active and Member Until is today or within `daysBefore` days. Every other member
 * carrying the tag loses it: one who renewed (the date moved out of the window), lapsed (no longer
 * tagged active) or whose date passed. So a Journey that checks the tag before each email stops
 * reminding anyone who renewed, as Salesforce's flow did.
 */
export function planRenewalDue(members: readonly RenewalMember[], opts: RenewalDueOptions): RenewalDuePlan {
  const plan: RenewalDuePlan = { add: [], remove: [], due: 0 };
  for (const m of members) {
    const tags = new Set((m.tags ?? []).map((t) => t.name));
    const until = String(m.merge_fields?.[opts.untilField] ?? '');
    const days = daysUntil(until, opts.today);
    const due = tags.has(opts.activeTag) && days >= 0 && days <= opts.daysBefore;
    if (due) plan.due += 1;
    if (due && !tags.has(opts.dueTag)) plan.add.push(m.email_address);
    else if (!due && tags.has(opts.dueTag)) plan.remove.push(m.email_address);
  }
  return plan;
}
