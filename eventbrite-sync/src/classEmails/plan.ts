// Decides who gets each class email and when a send must be refused. Pure: no I/O, no logging.
// Labels are compared exactly as Monday spells them.
import type { ClassEmailKind, ClassEmailRow } from '../db/classEmails';

export interface RosterEntry {
  registrationId: string;
  attendance: string;
  role: string;
  email: string;
  firstName: string;
  name: string;
}

export interface ClassFacts {
  startsAt: string | null;
  endsAt: string | null;
  eventbriteStatus: string | null;
}

export interface Recipient {
  registrationId: string;
  email: string;
  firstName: string;
  name: string;
}

export interface KindPlan {
  refusal: string | null;
  recipients: Recipient[];
  sent: number;
  unresolved: Recipient[];
}

// An allowlist: draft, a missing status and anything Eventbrite adds later all refuse until listed.
const SENDABLE_EVENT_STATUSES = ['live', 'started', 'ended', 'completed'];
const ELIGIBLE_ROLE = 'Participant';
const ELIGIBLE_ATTENDANCE: Record<ClassEmailKind, string[]> = {
  reminder: ['Registered'],
  'thank-you': ['Attended'],
  'missed-you': ['Registered', 'No Show'],
};

const normalize = (email: string): string => email.trim().toLowerCase();

// Checked in, on a row that counts: a volunteer or a row with no address proves nothing about the
// class, whether for the check-in guard or for "this address already came".
const isCheckedIn = (e: RosterEntry): boolean => e.attendance === 'Attended' && e.role === ELIGIBLE_ROLE && normalize(e.email) !== '';

function toRecipient(e: RosterEntry): Recipient {
  return { registrationId: e.registrationId, email: e.email, firstName: e.firstName, name: e.name };
}

function statusRefusal(status: string | null): string | null {
  if (status === null || status === '') return 'This class has no Eventbrite status yet, so no emails can be sent.';
  if (SENDABLE_EVENT_STATUSES.includes(status)) return null;
  if (status === 'canceled' || status === 'deleted') return `This class is ${status} on Eventbrite, so no emails can be sent.`;
  return `This class has the Eventbrite status "${status}", so no emails can be sent.`;
}

function refusalFor(kind: ClassEmailKind, facts: ClassFacts, roster: RosterEntry[], now: Date): string | null {
  const refused = statusRefusal(facts.eventbriteStatus);
  if (refused !== null) return refused;
  if (kind === 'reminder') {
    const startsAt = facts.startsAt === null ? NaN : Date.parse(facts.startsAt);
    if (Number.isNaN(startsAt)) return 'This class has no start time, so the reminder cannot be sent.';
    if (now.getTime() >= startsAt) return 'This class has already started, so the reminder can no longer be sent.';
    return null;
  }
  const endsAt = facts.endsAt === null ? NaN : Date.parse(facts.endsAt);
  if (Number.isNaN(endsAt)) return 'This class has no end time, so this email cannot be sent.';
  if (now.getTime() < endsAt) return 'This class has not ended yet, so this email cannot be sent.';
  if (!roster.some(isCheckedIn)) {
    return 'Nobody has been checked in for this class, so this email cannot be sent.';
  }
  return null;
}

export function planKind(kind: ClassEmailKind, facts: ClassFacts, roster: RosterEntry[], ledger: ClassEmailRow[], now: Date): KindPlan {
  const rows = ledger.filter((r) => r.kind === kind);
  const byId = new Map(roster.map((e) => [e.registrationId, e]));

  const sent = rows.filter((r) => r.status === 'sent').length;

  const unresolved: Recipient[] = [];
  const seenUnresolved = new Set<string>();
  for (const r of rows) {
    if (r.status === 'sent' || seenUnresolved.has(r.registrationId)) continue;
    seenUnresolved.add(r.registrationId);
    const e = byId.get(r.registrationId);
    unresolved.push(e ? toRecipient(e) : { registrationId: r.registrationId, email: '', firstName: '', name: '' });
  }

  const refusal = refusalFor(kind, facts, roster, now);
  if (refusal !== null) return { refusal, recipients: [], sent, unresolved };

  // Addresses already handled by any ledger row for this kind, whatever its status, are off limits.
  const taken = new Set<string>();
  for (const r of rows) {
    const e = byId.get(r.registrationId);
    if (e && normalize(e.email) !== '') taken.add(normalize(e.email));
  }
  // A person who attended on any registration of an address is not told they were missed.
  const attendedAddresses = new Set(roster.filter(isCheckedIn).map((e) => normalize(e.email)));
  const claimedIds = new Set(rows.map((r) => r.registrationId));

  const recipients: Recipient[] = [];
  for (const e of roster) {
    const address = normalize(e.email);
    if (address === '') continue;
    if (e.role !== ELIGIBLE_ROLE) continue;
    if (!ELIGIBLE_ATTENDANCE[kind].includes(e.attendance)) continue;
    if (claimedIds.has(e.registrationId) || taken.has(address)) continue;
    if (kind === 'missed-you' && attendedAddresses.has(address)) continue;
    taken.add(address);
    recipients.push(toRecipient(e));
  }

  return { refusal: null, recipients, sent, unresolved };
}
