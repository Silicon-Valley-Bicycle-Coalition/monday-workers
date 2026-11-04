import type { ItemPayload } from './types.js';
import { dateCol, funraiseTransactionLink, ownerAttribution, pacificDate, pacificDateCol, salesforceDebug } from './fields.js';
import { attributionColumns } from './attribution.js';

const ANNUAL: Record<string, number> = { Yearly: 1, Quarterly: 4, Monthly: 12 };

export function subscriptionToPayload(s: Record<string, unknown>): ItemPayload | null {
  if (s['Name'] === 'Redacted') return null; // erasure request — never re-materialize
  const amount = Number(s['funraise__Amount__c'] ?? 0);
  const mult = ANNUAL[s['funraise__Frequency__c'] as string] ?? 1;
  return {
    board: 'recurring-gifts', sfId: s['Id'] as string, name: (s['Name'] as string) ?? '(subscription)',
    columns: {
      'Funraise ID': funraiseTransactionLink(s['funraise__fr_ID__c']),
      'Installment Amount': String(amount), 'Annualized Value': String(amount * mult),
      'Frequency': { label: (s['funraise__Frequency__c'] ?? 'Unknown') as string },
      'Status': { label: (s['funraise__Status__c'] ?? 'Unknown') as string },
      'Next Payment': dateCol(s['funraise__Next_Payment_Date__c'] as string),
      'Designation': (s['funraise__Allocation_Name__c'] ?? '') as string,
      'Company Match': s['funraise__Company_Match__c'] ? { checked: 'true' } : null,
      'Match Employer': (s['funraise__Company_Match_Company_Name__c'] ?? '') as string,
      ...salesforceDebug(s),
    },
    links: s['funraise__Supporter__c']
      ? [{ column: 'Donor', targetSfIds: [s['funraise__Supporter__c'] as string] }] : [],
  };
}

// Contacts with an Active Funraise subscription: seeds People's Has Active Recurring Gift, which
// donation-rollups keeps current from the Recurring Gifts board after cutover. Status and donor
// are the same fields subscriptionToPayload maps to Status and the Donor link.
export function activeRecurringDonors(subscriptions: Record<string, unknown>[]): Set<string> {
  const out = new Set<string>();
  for (const s of subscriptions) {
    if (s['Name'] === 'Redacted' || s['funraise__Status__c'] !== 'Active') continue;
    const donor = s['funraise__Supporter__c'];
    if (typeof donor === 'string' && donor) out.add(donor);
  }
  return out;
}

export function pledgeColumnsBySubscription(pledges: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  for (const p of pledges) {
    const sub = p['funraise__Pledge_Subscription__c'] as string | null;
    if (sub) out.set(sub, {
      'Pledge Amount': String(p['funraise__Pledge_Amount__c'] ?? ''),
      'Received Amount': String(p['funraise__Received_Amount__c'] ?? ''),
    });
  }
  return out;
}

const TEST_EVENTS = new Set(['Test', 'Test Event']);

// Both event platforms land on the same two boards (events, event-registrations) — see
// migration-plan.md's Eventbrite addendum (2026-09-08). Source tells them apart; the platform ids
// are kept as text columns for idempotent upserts by the post-migration Eventbrite Worker.
type Label = { label: string };
const label = (l: string): Label => ({ label: l });

// Eventbrite's event lifecycle → the closed Event Status set shared with Funraise events.
const EVENTBRITE_EVENT_STATUS: Record<string, string> = {
  live: 'Upcoming', started: 'Upcoming', completed: 'Completed', canceled: 'Canceled', draft: 'Draft',
};

// SVBC runs one Eventbrite organizer account per program, distinguished only by a parenthesised
// suffix on the organizer name ("Silicon Valley Bicycle Coalition (volunteering)").
const ORGANIZER_PROGRAMS: Record<string, string> = {
  volunteering: 'Volunteering', 'bike parking': 'Bike Parking', 'group rides': 'Group Rides', private: 'Private',
};
export function programFromOrganizer(organizer: unknown): string {
  const suffix = /\(([^)]+)\)\s*$/.exec(String(organizer ?? ''))?.[1]?.trim().toLowerCase();
  return (suffix && ORGANIZER_PROGRAMS[suffix]) || 'Public';
}

export function eventToPayload(e: Record<string, unknown>, cutoverISO: string): ItemPayload | null {
  if (TEST_EVENTS.has(e['Name'] as string)) return null;
  const start = (e['funraise__Start_Date__c'] as string | null)?.slice(0, 10) ?? '';
  return {
    board: 'events', sfId: e['Id'] as string, name: (e['Name'] as string) ?? '(event)',
    columns: { 'Source': label('Funraise'), 'Program': label('Fundraiser'),
      'Event Status': label(start && start < cutoverISO ? 'Completed' : 'Upcoming'),
      'Date': dateCol(e['funraise__Start_Date__c'] as string),
      'City': '', 'Funraise Event ID': String(e['funraise__fr_ID__c'] ?? ''), ...salesforceDebug(e) },
  };
}

export function registrationToPayload(
  r: Record<string, unknown>, deps: { actingFor?: string | null; attribution?: 'Auto' | 'Needs review' } = {},
): ItemPayload {
  const attribution = attributionColumns(deps.actingFor ?? null, deps.attribution);
  const links: ItemPayload['links'] = [...attribution.links];
  if (r['funraise__Registrant__c']) links.push({ column: 'Attendee', targetSfIds: [r['funraise__Registrant__c'] as string] });
  if (r['funraise__Fundraising_Event__c']) links.push({ column: 'Event', targetSfIds: [r['funraise__Fundraising_Event__c'] as string] });
  if (r['funraise__Transaction__c']) links.push({ column: 'Payment', targetSfIds: [r['funraise__Transaction__c'] as string] });
  const fallbackName = [r['funraise__First_Name__c'], r['funraise__Last_Name__c']].filter(Boolean).join(' ');
  return {
    board: 'event-registrations', sfId: r['Id'] as string, name: fallbackName || (r['Id'] as string),
    columns: {
      'Source': label('Funraise'), 'Role': label('Participant'),
      'Attendee Name': fallbackName, 'Attendee Email': (r['funraise__Email__c'] ?? '') as string,
      'Ticket Type': (r['funraise__Ticket_Name__c'] ?? '') as string,
      'Ticket Amount': String(r['funraise__Ticket_Amount__c'] ?? ''),
      'Deductible Amount': String(r['funraise__Ticket_Tax_Deductible_Amount__c'] ?? ''),
      'Attendance': label(r['funraise__Attended__c'] ? 'Attended' : 'Registered'),
      ...attribution.columns,
      ...salesforceDebug(r),
    },
    links,
  };
}

type Venue = { eb4sf__Name__c?: string; eb4sf__City__c?: string; eb4sf__Localized_Address_Display__c?: string } | null;

export function eventbriteEventToPayload(
  e: Record<string, unknown>, cutoverISO: string, opts: { hasAttendees: boolean },
): ItemPayload | null {
  const status = String(e['eb4sf__Status__c'] ?? '');
  // Unpublished drafts nobody registered for are Eventbrite-side scratch, not SVBC history.
  if (status === 'draft' && !opts.hasAttendees) return null;
  const venue = (e['eb4sf__Eventbrite_Venue__r'] ?? null) as Venue;
  // `started` outlives the event: 84 of them in the 2026-11-02 org, every one already over, while
  // `live` was only ever future. So anything still "open" that ended before cutover is Completed.
  const lastDay = pacificDate((e['eb4sf__End__c'] ?? e['eb4sf__Start__c']) as string | null | undefined);
  const eventStatus = EVENTBRITE_EVENT_STATUS[status] ?? 'Completed';
  return {
    board: 'events', sfId: e['Id'] as string,
    name: (e['eb4sf__Event_Name__c'] as string) || (e['Name'] as string) || '(event)',
    columns: {
      'Source': label('Eventbrite'), 'Program': label(programFromOrganizer(e['eb4sf__Organizer_Name__c'])),
      'Event Status': label(eventStatus === 'Upcoming' && lastDay && lastDay < cutoverISO ? 'Completed' : eventStatus),
      'Date': pacificDateCol(e['eb4sf__Start__c'] as string), 'End': pacificDateCol(e['eb4sf__End__c'] as string),
      'Venue': venue?.eb4sf__Name__c ?? '', 'City': venue?.eb4sf__City__c ?? '',
      'Address': venue?.eb4sf__Localized_Address_Display__c ?? '',
      'Tickets Sold': String(e['eb4sf__Total_Tickets_Sold__c'] ?? ''),
      'Eventbrite ID': String(e['Name'] ?? ''), 'Eventbrite URL': (e['eb4sf__Event_URL__c'] ?? '') as string,
      ...salesforceDebug(e),
    },
  };
}

export function eventbriteAttendeeToPayload(
  a: Record<string, unknown>, event: Record<string, unknown> | undefined,
): ItemPayload | null {
  if (a['eb4sf__Status__c'] === 'Deleted') return null; // removed on the Eventbrite side
  const links: ItemPayload['links'] = [];
  if (a['eb4sf__Contact__c']) links.push({ column: 'Attendee', targetSfIds: [a['eb4sf__Contact__c'] as string] });
  if (a['eb4sf__Eventbrite_Event__c']) links.push({ column: 'Event', targetSfIds: [a['eb4sf__Eventbrite_Event__c'] as string] });
  const name = [a['eb4sf__First_Name__c'], a['eb4sf__Last_Name__c']].filter(Boolean).join(' ');
  const attendance = a['eb4sf__Checked_In__c'] ? 'Attended'
    : (a['eb4sf__Cancelled__c'] || a['eb4sf__Status__c'] === 'Not Attending') ? 'Canceled' : 'Registered';
  const role = programFromOrganizer(event?.['eb4sf__Organizer_Name__c']) === 'Volunteering' ? 'Volunteer' : 'Participant';
  return {
    board: 'event-registrations', sfId: a['Id'] as string, name: name || (a['Id'] as string),
    columns: {
      'Source': label('Eventbrite'), 'Role': label(role), 'Attendance': label(attendance),
      'Attendee Name': name, 'Attendee Email': (a['eb4sf__Email__c'] ?? '') as string,
      'Ticket Type': (a['eb4sf__Ticket_Class_Name__c'] ?? '') as string,
      'Ticket Amount': String(a['eb4sf__Base_Price__c'] ?? ''),
      'Eventbrite Attendee ID': String(a['Name'] ?? ''),
      ...salesforceDebug(a),
    },
    links,
  };
}

// Active, recently ended, or referenced by a migrated gift. The last was added 2026-10-26
// (monday-migration docs/24): inactive campaigns with no EndDate — the Bike to the Future
// homepages, peer-to-peer pages — were dropped however recent, leaving 3,752 Campaign links
// dangling.
export function campaignToPayload(c: Record<string, unknown>, keepSinceISO: string,
  referenced: ReadonlySet<string> = new Set()): ItemPayload | null {
  const recent = typeof c['EndDate'] === 'string' && c['EndDate'] >= keepSinceISO;
  if (c['IsActive'] !== true && !recent && !referenced.has(c['Id'] as string)) return null;
  return {
    board: 'campaigns', sfId: c['Id'] as string, name: (c['Name'] as string) ?? '(campaign)',
    columns: { 'Type': ((c['RecordType'] as { Name?: string } | null)?.Name ?? '') as string,
      'Start': dateCol(c['StartDate'] as string), 'End': dateCol(c['EndDate'] as string),
      'Active': c['IsActive'] ? { checked: 'true' } : null,
      'Salesforce Owner': ownerAttribution(c['Owner']), ...salesforceDebug(c) },
  };
}

export function volunteerHoursToPayload(v: Record<string, unknown>): ItemPayload {
  return {
    board: 'volunteers', sfId: v['Id'] as string,
    name: ((v['GW_Volunteers__Volunteer_Job__r'] as { Name?: string } | null)?.Name ?? 'Volunteer hours'),
    columns: { 'Job': ((v['GW_Volunteers__Volunteer_Job__r'] as { Name?: string } | null)?.Name ?? '') as string,
      'Hours': String(v['GW_Volunteers__Hours_Worked__c'] ?? ''),
      'Date': dateCol(v['GW_Volunteers__Start_Date__c'] as string),
      'Status': { label: (v['GW_Volunteers__Status__c'] ?? 'Unknown') as string },
      'Historical': { checked: 'true' }, ...salesforceDebug(v) },
    links: v['GW_Volunteers__Contact__c']
      ? [{ column: 'Volunteer', targetSfIds: [v['GW_Volunteers__Contact__c'] as string] }] : [],
  };
}

export function taskToPayload(t: Record<string, unknown>): ItemPayload {
  return {
    board: 'activities', sfId: t['Id'] as string, name: (t['Subject'] as string) ?? '(task)',
    columns: { 'Activity Type': { label: 'Task' },
      'Date': dateCol(t['ActivityDate'] as string),
      'Status': { label: (t['Status'] ?? 'Unknown') as string },
      'Owner': ownerAttribution(t['Owner']) },
    links: t['WhoId'] ? [{ column: 'Person', targetSfIds: [t['WhoId'] as string] }] : [],
  };
}
