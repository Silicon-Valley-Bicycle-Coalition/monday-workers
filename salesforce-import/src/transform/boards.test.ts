import { describe, it, expect } from 'vitest';
import { subscriptionToPayload, pledgeColumnsBySubscription, eventToPayload,
  registrationToPayload, eventbriteEventToPayload, eventbriteAttendeeToPayload,
  campaignToPayload, volunteerHoursToPayload, taskToPayload } from './boards.js';

const prov = { CreatedDate: '2024-01-01T00:00:00Z', CreatedBy: { Name: 'X' },
  LastModifiedDate: '2024-01-01T00:00:00Z', LastModifiedBy: { Name: 'X' } };

describe('subscriptionToPayload', () => {
  it('computes annualized value from frequency', () => {
    const p = subscriptionToPayload({ Id: 's1', Name: 'Sub', funraise__Supporter__c: 'c1',
      funraise__Amount__c: 10, funraise__Frequency__c: 'Monthly', funraise__Status__c: 'Active', ...prov })!;
    expect(p.columns['Annualized Value']).toBe('120');
    expect(p.columns['Status']).toEqual({ label: 'Active' });
    expect(p.links).toContainEqual({ column: 'Donor', targetSfIds: ['c1'] });
  });
  it('never re-materializes the Redacted subscription', () => {
    expect(subscriptionToPayload({ Id: 's2', Name: 'Redacted', ...prov })).toBeNull();
  });
});

describe('pledgeColumnsBySubscription', () => {
  it('folds pledge fields onto the subscription via funraise__Pledge_Subscription__c', () => {
    const m = pledgeColumnsBySubscription([{ Id: 'p1', funraise__Pledge_Subscription__c: 's1',
      funraise__Pledge_Amount__c: 120, funraise__Received_Amount__c: 60 }]);
    expect(m.get('s1')).toEqual({ 'Pledge Amount': '120', 'Received Amount': '60' });
  });
});

describe('eventToPayload', () => {
  const CUTOVER = '2026-10-01';
  it('drops test events', () => {
    expect(eventToPayload({ Id: 'e1', Name: 'Test Event', ...prov }, CUTOVER)).toBeNull();
  });
  it('emits no Local News column (removed 2026-08-23 — not useful yet)', () => {
    const p = eventToPayload({ Id: 'e2', Name: 'Gala', funraise__Start_Date__c: '2025-05-01',
      ...prov }, CUTOVER)!;
    expect(p.columns['Local News']).toBeUndefined();
  });
  it('tags Funraise events with Source, Program and the Funraise event id', () => {
    const p = eventToPayload({ Id: 'e2', Name: 'Gala', funraise__fr_ID__c: '4242',
      funraise__Start_Date__c: '2025-05-01T14:00:00.000+0000', ...prov }, CUTOVER)!;
    expect(p.board).toBe('events');
    expect(p.columns['Source']).toEqual({ label: 'Funraise' });
    expect(p.columns['Program']).toEqual({ label: 'Fundraiser' });
    expect(p.columns['Funraise Event ID']).toBe('4242');
    expect(p.columns['Date']).toEqual({ date: '2025-05-01' });
  });
  it('derives Event Status from the start date relative to cutover', () => {
    const past = eventToPayload({ Id: 'e3', Name: 'Past', funraise__Start_Date__c: '2025-10-26', ...prov }, CUTOVER)!;
    const future = eventToPayload({ Id: 'e4', Name: 'Next', funraise__Start_Date__c: '2026-10-26', ...prov }, CUTOVER)!;
    expect(past.columns['Event Status']).toEqual({ label: 'Completed' });
    expect(future.columns['Event Status']).toEqual({ label: 'Upcoming' });
  });
});

describe('registrationToPayload', () => {
  it('falls back to denormalized fields for the 86 orphans', () => {
    const p = registrationToPayload({ Id: 'r1', funraise__Registrant__c: null,
      funraise__First_Name__c: 'Ada', funraise__Last_Name__c: 'L', funraise__Email__c: 'a@b.c',
      funraise__Fundraising_Event__c: 'e2', funraise__Attended__c: true, ...prov });
    expect(p.links).toEqual([{ column: 'Event', targetSfIds: ['e2'] }]);
    expect(p.columns['Attendee Name']).toBe('Ada L');
  });
  it('maps Attended to the shared Attendance status and tags Source/Role/Ticket Type', () => {
    const attended = registrationToPayload({ Id: 'r1', funraise__Fundraising_Event__c: 'e2',
      funraise__Attended__c: true, funraise__Ticket_Name__c: 'General Admission', ...prov });
    const registered = registrationToPayload({ Id: 'r2', funraise__Fundraising_Event__c: 'e2',
      funraise__Attended__c: false, ...prov });
    expect(attended.columns['Attendance']).toEqual({ label: 'Attended' });
    expect(registered.columns['Attendance']).toEqual({ label: 'Registered' });
    expect(attended.columns['Attended']).toBeUndefined();
    expect(attended.columns['Source']).toEqual({ label: 'Funraise' });
    expect(attended.columns['Role']).toEqual({ label: 'Participant' });
    expect(attended.columns['Ticket Type']).toBe('General Admission');
  });
});

describe('eventbriteEventToPayload', () => {
  const venue = { eb4sf__Name__c: 'Stanford Stadium', eb4sf__City__c: 'Palo Alto',
    eb4sf__Localized_Address_Display__c: '625 Nelson Rd, Palo Alto, CA 94305' };
  const base = { Id: 'eb1', Name: '1999043957289', eb4sf__Event_Name__c: 'Bike Parking at Stanford Stadium',
    eb4sf__Start__c: '2026-09-05T00:00:00.000+0000', eb4sf__End__c: '2026-09-05T02:00:00.000+0000',
    eb4sf__Event_URL__c: 'https://www.eventbrite.com/e/x-tickets-1999043957289',
    eb4sf__Status__c: 'completed', eb4sf__Organizer_Name__c: 'Silicon Valley Bicycle Coalition (bike parking)',
    eb4sf__Total_Tickets_Sold__c: 12, eb4sf__Eventbrite_Venue__r: venue, ...prov };
  it('lands on the events board with the Eventbrite id, venue and program columns', () => {
    const p = eventbriteEventToPayload(base, { hasAttendees: true })!;
    expect(p.board).toBe('events');
    expect(p.sfId).toBe('eb1');
    expect(p.name).toBe('Bike Parking at Stanford Stadium');
    expect(p.columns['Source']).toEqual({ label: 'Eventbrite' });
    expect(p.columns['Eventbrite ID']).toBe('1999043957289');
    expect(p.columns['Eventbrite URL']).toBe('https://www.eventbrite.com/e/x-tickets-1999043957289');
    expect(p.columns['Date']).toEqual({ date: '2026-09-05' });
    expect(p.columns['End']).toEqual({ date: '2026-09-05' });
    expect(p.columns['Venue']).toBe('Stanford Stadium');
    expect(p.columns['City']).toBe('Palo Alto');
    expect(p.columns['Address']).toBe('625 Nelson Rd, Palo Alto, CA 94305');
    expect(p.columns['Tickets Sold']).toBe('12');
    expect(p.columns['Program']).toEqual({ label: 'Bike Parking' });
    expect(p.columns['Event Status']).toEqual({ label: 'Completed' });
  });
  it('maps every Eventbrite status onto the closed Event Status set', () => {
    const status = (s: string) => eventbriteEventToPayload({ ...base, eb4sf__Status__c: s }, { hasAttendees: true })!
      .columns['Event Status'];
    expect(status('live')).toEqual({ label: 'Upcoming' });
    expect(status('started')).toEqual({ label: 'Upcoming' });
    expect(status('canceled')).toEqual({ label: 'Canceled' });
    expect(status('draft')).toEqual({ label: 'Draft' });
  });
  it('maps the organizer account suffix onto Program, defaulting to Public', () => {
    const program = (o: string) => eventbriteEventToPayload({ ...base, eb4sf__Organizer_Name__c: o }, { hasAttendees: true })!
      .columns['Program'];
    expect(program('Silicon Valley Bicycle Coalition')).toEqual({ label: 'Public' });
    expect(program('Silicon Valley Bicycle Coalition (volunteering)')).toEqual({ label: 'Volunteering' });
    expect(program('Silicon Valley Bicycle Coalition (Group Rides)')).toEqual({ label: 'Group Rides' });
    expect(program('Silicon Valley Bicycle Coalition (private)')).toEqual({ label: 'Private' });
  });
  it('drops unpublished drafts nobody registered for, keeps drafts with attendees', () => {
    expect(eventbriteEventToPayload({ ...base, eb4sf__Status__c: 'draft' }, { hasAttendees: false })).toBeNull();
    expect(eventbriteEventToPayload({ ...base, eb4sf__Status__c: 'draft' }, { hasAttendees: true })).not.toBeNull();
    expect(eventbriteEventToPayload(base, { hasAttendees: false })).not.toBeNull();
  });
  it('tolerates a missing venue (online events)', () => {
    const p = eventbriteEventToPayload({ ...base, eb4sf__Eventbrite_Venue__r: null }, { hasAttendees: true })!;
    expect(p.columns['Venue']).toBe('');
    expect(p.columns['City']).toBe('');
  });
});

describe('eventbriteAttendeeToPayload', () => {
  const volunteering = { eb4sf__Organizer_Name__c: 'Silicon Valley Bicycle Coalition (volunteering)' };
  const publicEvent = { eb4sf__Organizer_Name__c: 'Silicon Valley Bicycle Coalition' };
  const base = { Id: 'at1', Name: '21571829423', eb4sf__First_Name__c: 'Quynh', eb4sf__Last_Name__c: 'Pham',
    eb4sf__Email__c: 'q@example.com', eb4sf__Status__c: 'Attending', eb4sf__Checked_In__c: false,
    eb4sf__Cancelled__c: false, eb4sf__Ticket_Class_Name__c: 'Smart Cycling 1', eb4sf__Base_Price__c: 0,
    eb4sf__Contact__c: 'c1', eb4sf__Eventbrite_Event__c: 'eb1', ...prov };
  it('lands on event-registrations linked to the Contact and the Eventbrite event', () => {
    const p = eventbriteAttendeeToPayload(base, publicEvent)!;
    expect(p.board).toBe('event-registrations');
    expect(p.sfId).toBe('at1');
    expect(p.name).toBe('Quynh Pham');
    expect(p.links).toEqual([
      { column: 'Attendee', targetSfIds: ['c1'] },
      { column: 'Event', targetSfIds: ['eb1'] },
    ]);
    expect(p.columns['Source']).toEqual({ label: 'Eventbrite' });
    expect(p.columns['Eventbrite Attendee ID']).toBe('21571829423');
    expect(p.columns['Attendee Name']).toBe('Quynh Pham');
    expect(p.columns['Attendee Email']).toBe('q@example.com');
    expect(p.columns['Ticket Type']).toBe('Smart Cycling 1');
    expect(p.columns['Ticket Amount']).toBe('0');
    expect(p.columns['Role']).toEqual({ label: 'Participant' });
  });
  it('derives Attendance from check-in and cancellation', () => {
    const attendance = (row: Record<string, unknown>) => eventbriteAttendeeToPayload({ ...base, ...row }, publicEvent)!
      .columns['Attendance'];
    expect(attendance({})).toEqual({ label: 'Registered' });
    expect(attendance({ eb4sf__Status__c: 'Checked In', eb4sf__Checked_In__c: true })).toEqual({ label: 'Attended' });
    expect(attendance({ eb4sf__Status__c: 'Not Attending', eb4sf__Cancelled__c: true })).toEqual({ label: 'Canceled' });
  });
  it('marks attendees of the volunteering organizer as Volunteers', () => {
    expect(eventbriteAttendeeToPayload(base, volunteering)!.columns['Role']).toEqual({ label: 'Volunteer' });
  });
  it('drops attendees Eventbrite itself deleted', () => {
    expect(eventbriteAttendeeToPayload({ ...base, eb4sf__Status__c: 'Deleted' }, publicEvent)).toBeNull();
  });
  it('skips the Contact link for the 21 unlinked attendees but still names them', () => {
    const p = eventbriteAttendeeToPayload({ ...base, eb4sf__Contact__c: null }, undefined)!;
    expect(p.links).toEqual([{ column: 'Event', targetSfIds: ['eb1'] }]);
    expect(p.name).toBe('Quynh Pham');
    expect(p.columns['Role']).toEqual({ label: 'Participant' });
  });

  it('registrationToPayload carries Acting for and Attribution', () => {
    const r = { Id: 'r1', funraise__Registrant__c: 'c2', funraise__Email__c: 'bo@sanjoseca.gov' };
    expect(registrationToPayload(r, { actingFor: 'af-city' }).links).toContainEqual({ column: 'Acting for', targetSfIds: ['af-city'] });
    expect(registrationToPayload(r, { actingFor: 'af-city' }).columns['Attribution']).toEqual({ label: 'Auto' });
    expect(registrationToPayload(r).columns['Attribution']).toEqual({ label: 'None' });
  });

  it('registrationToPayload emits Needs review when the registrant does not match the attributed affiliation', () => {
    const r = { Id: 'r2', funraise__Registrant__c: 'c-other', funraise__Email__c: 'bo@sanjoseca.gov' };
    const p = registrationToPayload(r, { actingFor: 'af-city', attribution: 'Needs review' });
    expect(p.columns['Attribution']).toEqual({ label: 'Needs review' });
    expect(p.links).toContainEqual({ column: 'Acting for', targetSfIds: ['af-city'] });
  });
});

describe('campaignToPayload', () => {
  const since = '2019-01-01';
  it('prunes inactive old campaigns, keeps active or recent', () => {
    expect(campaignToPayload({ Id: 'k1', Name: 'Old', IsActive: false, EndDate: '2012-01-01', ...prov }, since)).toBeNull();
    expect(campaignToPayload({ Id: 'k2', Name: 'Now', IsActive: true, ...prov }, since)).not.toBeNull();
    expect(campaignToPayload({ Id: 'k3', Name: 'Recent', IsActive: false, EndDate: '2023-01-01', ...prov }, since)).not.toBeNull();
  });
  it('keeps any campaign a migrated gift references, however old (decided 2026-10-26)', () => {
    const referenced = new Set(['k1', 'k5']);
    expect(campaignToPayload({ Id: 'k1', Name: 'Old', IsActive: false, EndDate: '2012-01-01', ...prov }, since, referenced)).not.toBeNull();
    // No EndDate and inactive: dropped before, however recent — the Bike to the Future pages.
    expect(campaignToPayload({ Id: 'k5', Name: 'Bike to the Future 2025', IsActive: false, ...prov }, since, referenced)).not.toBeNull();
    expect(campaignToPayload({ Id: 'k6', Name: 'Unused', IsActive: false, ...prov }, since, referenced)).toBeNull();
  });
  it('sets Salesforce Owner from Campaign.Owner', () => {
    const p = campaignToPayload({ Id: 'k4', Name: 'Now', IsActive: true, Owner: { Name: 'Jessica Waite' }, ...prov }, since)!;
    expect(p.columns['Salesforce Owner']).toBe('Jessica Waite');
  });
});

describe('volunteers + activities', () => {
  it('tags volunteer history as historical', () => {
    const p = volunteerHoursToPayload({ Id: 'v1', GW_Volunteers__Contact__c: 'c1',
      GW_Volunteers__Hours_Worked__c: 3, GW_Volunteers__Start_Date__c: '2016-04-01',
      GW_Volunteers__Volunteer_Job__r: { Name: 'BTWD Station' }, GW_Volunteers__Status__c: 'Completed', ...prov });
    expect(p.board).toBe('volunteers');
    expect(p.columns['Historical']).toEqual({ checked: 'true' });
    expect(p.columns['Job']).toBe('BTWD Station');
  });
  it('maps tasks onto the activities board with a person link', () => {
    const p = taskToPayload({ Id: 'tk1', WhoId: 'c1', Subject: 'Call re: renewal',
      ActivityDate: '2025-03-01', Status: 'Completed', Owner: { Name: 'Staff' }, CreatedDate: '2025-03-01T00:00:00Z' });
    expect(p.board).toBe('activities');
    expect(p.columns['Activity Type']).toEqual({ label: 'Task' });
    expect(p.links).toEqual([{ column: 'Person', targetSfIds: ['c1'] }]);
  });
});
