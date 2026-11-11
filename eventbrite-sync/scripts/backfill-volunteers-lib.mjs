// Pure planning for backfill-volunteers.mjs: which Event Registrations volunteer rows become
// Volunteers items, their column values, the count check before archiving, the resume ledger, and
// the SQL that points both D1 ledgers at the new item ids. No I/O here, so it is testable without
// Monday or D1.
//
// Reg:          { itemId, attendeeId, role, attendance, eventItemId, personItemId, name, email }
//               (attendance is the Attendance label, '' when blank; ids are strings or null)
// ListingFacts: { name, date, program } for an Events item id (date YYYY-MM-DD or null)

import { toVolunteerStatus } from '../src/mapping/volunteerStatus.ts';

export const DEFAULT_VOLUNTEER_PROGRAMS = ['Volunteering'];

const attendeeIdOf = (r) => (typeof r.attendeeId === 'string' ? r.attendeeId.trim() : '');

// Why a Volunteer-role registration can't be moved, or null when it can. Never guesses: no
// attendee id means there is no key to stay idempotent on, and a listing we can't confirm as a
// volunteer event (none, unknown, or another program) stays where it is.
function ineligibility(r, listings, programs) {
  if (attendeeIdOf(r) === '') return 'no-attendee-id';
  const listing = r.eventItemId === null ? undefined : listings.get(r.eventItemId);
  if (listing === undefined || !programs.includes(listing.program)) return 'not-a-volunteering-event';
  return null;
}

const volunteerRows = (registrations) => registrations.filter((r) => r.role === 'Volunteer');

export function planBackfill(registrations, listings, existingVolunteerAttendeeIds, volunteerPrograms = DEFAULT_VOLUNTEER_PROGRAMS) {
  const create = [];
  const skipped = [];
  const planned = new Set(existingVolunteerAttendeeIds);
  for (const r of volunteerRows(registrations)) {
    const reason = ineligibility(r, listings, volunteerPrograms);
    if (reason !== null) {
      skipped.push({ itemId: r.itemId, reason });
      continue;
    }
    const attendeeId = attendeeIdOf(r);
    // Already on the board, or a second registration of an attendee planned above: one item each.
    if (planned.has(attendeeId)) {
      skipped.push({ itemId: r.itemId, reason: 'already-moved' });
      continue;
    }
    planned.add(attendeeId);
    const listing = listings.get(r.eventItemId);
    const name = typeof r.name === 'string' && r.name.trim() !== '' ? r.name.trim() : null;
    const email = typeof r.email === 'string' && r.email.trim() !== '' ? r.email.trim() : null;
    create.push({
      registrationItemId: r.itemId,
      attendeeId,
      eventItemId: r.eventItemId,
      listingItemId: r.eventItemId,
      personItemId: r.personItemId ?? null,
      itemName: name ?? `Eventbrite attendee ${attendeeId}`,
      name,
      email,
      job: listing.name,
      date: listing.date ?? null,
      status: toVolunteerStatus(r.attendance),
    });
  }
  return { create, skipped };
}

const link = (id) => ({ item_ids: [Number.isFinite(Number(id)) ? Number(id) : id] });

// The create_item column values for one plan, in the shape processVolunteer writes on create.
export function volunteerColumnValues(plan, cols) {
  const values = {
    [cols.attendeeIdColumn]: plan.attendeeId,
    [cols.statusColumn]: plan.status,
    [cols.jobColumn]: plan.job,
    [cols.historicalColumn]: { checked: 'false' },
  };
  if (plan.date !== null) values[cols.dateColumn] = { date: plan.date };
  if (plan.name !== null) values[cols.attendeeNameColumn] = plan.name;
  if (plan.email !== null) values[cols.attendeeEmailColumn] = { email: plan.email, text: plan.email };
  values[cols.eventColumn] = link(plan.eventItemId);
  values[cols.listingColumn] = link(plan.listingItemId);
  if (plan.personItemId !== null) values[cols.volunteerLinkColumn] = link(plan.personItemId);
  return values;
}

// After creating: every eligible registration's ledger move, and whether the originals may be
// archived. The count is by attendee (duplicates share one item): eligible attendees must all be on
// the Volunteers board, or nothing is archived.
export function reconcile(registrations, listings, volunteerItemIdByAttendeeId, volunteerPrograms = DEFAULT_VOLUNTEER_PROGRAMS) {
  const eligible = volunteerRows(registrations).filter((r) => ineligibility(r, listings, volunteerPrograms) === null);
  const attendees = new Set(eligible.map(attendeeIdOf));
  const present = [...attendees].filter((a) => volunteerItemIdByAttendeeId.has(a)).length;
  const moves = [];
  const missing = [];
  for (const r of eligible) {
    const newItemId = volunteerItemIdByAttendeeId.get(attendeeIdOf(r));
    if (newItemId === undefined) missing.push(r.itemId);
    else moves.push({ attendeeId: attendeeIdOf(r), oldItemId: r.itemId, newItemId });
  }
  const ok = attendees.size > 0 && present === attendees.size;
  return { moves, eligible: attendees.size, present, missing, ok, toArchive: ok ? eligible.map((r) => r.itemId) : [] };
}

const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;

// One statement per line (wrangler d1 execute --file, and D1 exec, both read that). The attendee
// ledger is keyed by attendee id; class-email claims by the registration item id they were made for.
export function remapSql(moves) {
  return moves.flatMap(({ attendeeId, oldItemId, newItemId }) => [
    `UPDATE attendees SET monday_item_id = ${sqlString(newItemId)} WHERE attendee_id = ${sqlString(attendeeId)};`,
    `UPDATE class_email_recipients SET registration_item_id = ${sqlString(newItemId)} WHERE registration_item_id = ${sqlString(oldItemId)};`,
  ]).join('\n') + '\n';
}

// Resume ledger: one JSON object per line, appended after each confirmed create. Ids only.
export function ledgerLine({ attendeeId, registrationItemId, volunteerItemId }) {
  return JSON.stringify({ attendeeId, registrationItemId, volunteerItemId }) + '\n';
}

export function parseLedger(text) {
  const byAttendee = new Map();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // a line torn by an interrupted write; the board lookup covers it
    }
    if (typeof row.attendeeId === 'string' && typeof row.volunteerItemId === 'string') byAttendee.set(row.attendeeId, row.volunteerItemId);
  }
  return byAttendee;
}

// A status cell's label, or '' when blank: Monday's text for an EMPTY status cell is label 5's, so
// only a stored value with a numeric index counts (as statusText in src/monday/client.ts).
export function statusLabel(text, value) {
  if (value === null || value === undefined || String(value).trim() === '') return '';
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return '';
  }
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.index !== 'number') return '';
  return (text ?? '').trim();
}

export function isoDate(text) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(text ?? '');
  return m ? m[1] : null;
}
