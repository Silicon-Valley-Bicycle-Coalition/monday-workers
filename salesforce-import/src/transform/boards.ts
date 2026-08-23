import type { ItemPayload } from './types.js';
import { dateCol, provenanceColumns } from './fields.js';

const ANNUAL: Record<string, number> = { Yearly: 1, Quarterly: 4, Monthly: 12 };

export function subscriptionToPayload(s: Record<string, unknown>): ItemPayload | null {
  if (s['Name'] === 'Redacted') return null; // erasure request — never re-materialize
  const amount = Number(s['funraise__Amount__c'] ?? 0);
  const mult = ANNUAL[s['funraise__Frequency__c'] as string] ?? 1;
  return {
    board: 'recurring-gifts', sfId: s['Id'] as string, name: (s['Name'] as string) ?? '(subscription)',
    columns: {
      'SF ID': s['Id'], 'Funraise ID': (s['funraise__fr_ID__c'] ?? '') as string,
      'Installment Amount': String(amount), 'Annualized Value': String(amount * mult),
      'Frequency': { label: (s['funraise__Frequency__c'] ?? 'Unknown') as string },
      'Status': { label: (s['funraise__Status__c'] ?? 'Unknown') as string },
      'Next Payment': dateCol(s['funraise__Next_Payment_Date__c'] as string),
      'Designation': (s['funraise__Allocation_Name__c'] ?? '') as string,
      'Company Match': s['funraise__Company_Match__c'] ? { checked: 'true' } : null,
      'Match Employer': (s['funraise__Company_Match_Company_Name__c'] ?? '') as string,
      ...provenanceColumns(s),
    },
    links: s['funraise__Supporter__c']
      ? [{ column: 'Donor', targetSfIds: [s['funraise__Supporter__c'] as string] }] : [],
  };
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

export function eventToPayload(e: Record<string, unknown>): ItemPayload | null {
  if (TEST_EVENTS.has(e['Name'] as string)) return null;
  return {
    board: 'events', sfId: e['Id'] as string, name: (e['Name'] as string) ?? '(event)',
    columns: { 'SF ID': e['Id'], 'Date': dateCol(e['funraise__Start_Date__c'] as string),
      'City': '', ...provenanceColumns(e) },
  };
}

export function registrationToPayload(r: Record<string, unknown>): ItemPayload {
  const links: ItemPayload['links'] = [];
  if (r['funraise__Registrant__c']) links.push({ column: 'Attendee', targetSfIds: [r['funraise__Registrant__c'] as string] });
  if (r['funraise__Fundraising_Event__c']) links.push({ column: 'Event', targetSfIds: [r['funraise__Fundraising_Event__c'] as string] });
  if (r['funraise__Transaction__c']) links.push({ column: 'Payment', targetSfIds: [r['funraise__Transaction__c'] as string] });
  const fallbackName = [r['funraise__First_Name__c'], r['funraise__Last_Name__c']].filter(Boolean).join(' ');
  return {
    board: 'event-registrations', sfId: r['Id'] as string, name: fallbackName || (r['Id'] as string),
    columns: {
      'SF ID': r['Id'],
      'Attendee Name': fallbackName, 'Attendee Email': (r['funraise__Email__c'] ?? '') as string,
      'Ticket Amount': String(r['funraise__Ticket_Amount__c'] ?? ''),
      'Deductible Amount': String(r['funraise__Ticket_Tax_Deductible_Amount__c'] ?? ''),
      'Attended': r['funraise__Attended__c'] ? { checked: 'true' } : null,
      ...provenanceColumns(r),
    },
    links,
  };
}

export function campaignToPayload(c: Record<string, unknown>, keepSinceISO: string): ItemPayload | null {
  const recent = typeof c['EndDate'] === 'string' && c['EndDate'] >= keepSinceISO;
  if (c['IsActive'] !== true && !recent) return null;
  return {
    board: 'campaigns', sfId: c['Id'] as string, name: (c['Name'] as string) ?? '(campaign)',
    columns: { 'SF ID': c['Id'],
      'Type': ((c['RecordType'] as { Name?: string } | null)?.Name ?? '') as string,
      'Start': dateCol(c['StartDate'] as string), 'End': dateCol(c['EndDate'] as string),
      'Active': c['IsActive'] ? { checked: 'true' } : null, ...provenanceColumns(c) },
  };
}

export function volunteerHoursToPayload(v: Record<string, unknown>): ItemPayload {
  return {
    board: 'volunteers', sfId: v['Id'] as string,
    name: ((v['GW_Volunteers__Volunteer_Job__r'] as { Name?: string } | null)?.Name ?? 'Volunteer hours'),
    columns: { 'SF ID': v['Id'],
      'Job': ((v['GW_Volunteers__Volunteer_Job__r'] as { Name?: string } | null)?.Name ?? '') as string,
      'Hours': String(v['GW_Volunteers__Hours_Worked__c'] ?? ''),
      'Date': dateCol(v['GW_Volunteers__Start_Date__c'] as string),
      'Status': { label: (v['GW_Volunteers__Status__c'] ?? 'Unknown') as string },
      'Historical': { checked: 'true' }, ...provenanceColumns(v) },
    links: v['GW_Volunteers__Contact__c']
      ? [{ column: 'Volunteer', targetSfIds: [v['GW_Volunteers__Contact__c'] as string] }] : [],
  };
}

export function taskToPayload(t: Record<string, unknown>): ItemPayload {
  return {
    board: 'activities', sfId: t['Id'] as string, name: (t['Subject'] as string) ?? '(task)',
    columns: { 'SF ID': t['Id'], 'Activity Type': { label: 'Task' },
      'Date': dateCol(t['ActivityDate'] as string),
      'Status': { label: (t['Status'] ?? 'Unknown') as string },
      'Owner': ((t['Owner'] as { Name?: string } | null)?.Name ?? '') as string },
    links: t['WhoId'] ? [{ column: 'Person', targetSfIds: [t['WhoId'] as string] }] : [],
  };
}
