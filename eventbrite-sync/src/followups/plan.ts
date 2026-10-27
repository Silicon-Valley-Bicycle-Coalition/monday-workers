import { toISODate } from '../util/isoDate';
import type { EventRow } from '../types';

// The morning-after class follow-ups (docs/superpowers/specs/2026-10-26-eventbrite-attendees-class-emails-design.md,
// "Follow-ups (the automated part)"). Pure: what's due and what to write. run.ts does the I/O.

const TIME_ZONE = 'America/Los_Angeles';
const DAY_MS = 24 * 60 * 60 * 1000;

const pacificParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

// Pacific wall-clock time at `ms`, read back as if it were UTC — minus `ms`, that's the offset.
function pacificOffsetMs(ms: number): number {
  const p = Object.fromEntries(pacificParts.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return wall - Math.floor(ms / 1000) * 1000;
}

// The UTC instant of `hour`:00 Pacific on the calendar day after `isoDate` (YYYY-MM-DD).
// The offset is taken at that instant itself, so a DST change overnight is handled.
function pacificHourOnNextDay(isoDate: string, hour: number): number {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d + 1, hour);
  const first = naive - pacificOffsetMs(naive);
  return naive - pacificOffsetMs(first);
}

// Only an event that ran gets follow-ups. An allowlist, because Eventbrite also reports `deleted`
// for a canceled event that was removed, and any status it adds later should send nothing.
const RAN_STATUSES = new Set(['live', 'started', 'ended', 'completed']);

export function isDue(row: EventRow, now: Date, cfg: { maxAgeDays: number; sendHourLocal: number }): boolean {
  if (!RAN_STATUSES.has(row.eventbriteStatus ?? '') || row.endsAt === null) return false;
  const endsMs = Date.parse(row.endsAt);
  const endDay = toISODate(row.endsAt);
  if (Number.isNaN(endsMs) || endDay === null) return false;
  const nowMs = now.getTime();
  return nowMs >= pacificHourOnNextDay(endDay, cfg.sendHourLocal) && endsMs >= nowMs - cfg.maxAgeDays * DAY_MS;
}

// A registration as read from Monday: Attendance label text, the Attendee Email address, and its
// current Follow-up Email label (blank or absent when none has been written).
export type Registration = { itemId: string; attendance: string; email: string; followupEmail?: string };

export type FollowupWrite = { itemId: string; label: string; noShow: boolean };
export type FollowupPlan = { outcome: 'held' } | { outcome: 'send'; writes: FollowupWrite[] };

export function planFollowups(regs: Registration[], classType: string): FollowupPlan {
  // The check-in guard: no Attended at all (with or without an email) means check-ins weren't
  // done, so nobody gets a missed-you they don't deserve.
  if (!regs.some((r) => r.attendance === 'Attended')) return { outcome: 'held' };

  // An address that already carries a Follow-up Email label was handled by an earlier run that
  // stopped before Follow-ups Sent; picking it again could email a sibling registration on the
  // same address a second time.
  const handled = new Set(regs.filter((r) => (r.followupEmail ?? '').trim() !== '').map((r) => r.email.trim().toLowerCase()));

  // One email per address per class: the first Attended registration for an address wins; failing
  // that, the first Registered one. Canceled and No Show get nothing.
  const chosen = new Map<string, Registration>();
  for (const reg of regs) {
    if (reg.attendance !== 'Attended' && reg.attendance !== 'Registered') continue;
    const key = reg.email.trim().toLowerCase();
    if (key === '' || handled.has(key)) continue;
    const current = chosen.get(key);
    if (current === undefined || (current.attendance === 'Registered' && reg.attendance === 'Attended')) chosen.set(key, reg);
  }

  const winners = new Set(chosen.values());
  const writes = regs
    .filter((reg) => winners.has(reg))
    .map((reg) =>
      reg.attendance === 'Attended'
        ? { itemId: reg.itemId, label: `Thank-you: ${classType}`, noShow: false }
        : { itemId: reg.itemId, label: `Missed-you: ${classType}`, noShow: true }
    );
  return { outcome: 'send', writes };
}
