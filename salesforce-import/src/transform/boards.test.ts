import { describe, it, expect } from 'vitest';
import { subscriptionToPayload, pledgeColumnsBySubscription, eventToPayload,
  registrationToPayload, campaignToPayload, volunteerHoursToPayload, taskToPayload } from './boards.js';

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
  const news = { rules: [{ cities: ['san jose'], url: 'https://sanjosespotlight.com/' }],
    defaultUrl: 'https://localnewsmatters.org/' };
  it('drops test events', () => {
    expect(eventToPayload({ Id: 'e1', Name: 'Test Event', ...prov }, news)).toBeNull();
  });
  it('carries the Local News link from the default outlet when no city field exists', () => {
    const p = eventToPayload({ Id: 'e2', Name: 'Gala', funraise__Start_Date__c: '2025-05-01',
      ...prov }, news)!;
    expect(p.columns['Local News']).toMatchObject({ url: 'https://localnewsmatters.org/' });
  });
});

describe('registrationToPayload', () => {
  it('falls back to denormalized fields for the 86 orphans', () => {
    const p = registrationToPayload({ Id: 'r1', funraise__Registrant__c: null,
      funraise__First_Name__c: 'Ada', funraise__Last_Name__c: 'L', funraise__Email__c: 'a@b.c',
      funraise__Fundraising_Event__c: 'e2', funraise__Attended__c: true, ...prov });
    expect(p.links).toEqual([{ column: 'Event', targetSfIds: ['e2'] }]);
    expect(p.columns['Attendee Name']).toBe('Ada L');
    expect(p.columns['Attended']).toEqual({ checked: 'true' });
  });
});

describe('campaignToPayload', () => {
  const since = '2019-01-01';
  it('prunes inactive old campaigns, keeps active or recent', () => {
    expect(campaignToPayload({ Id: 'k1', Name: 'Old', IsActive: false, EndDate: '2012-01-01', ...prov }, since)).toBeNull();
    expect(campaignToPayload({ Id: 'k2', Name: 'Now', IsActive: true, ...prov }, since)).not.toBeNull();
    expect(campaignToPayload({ Id: 'k3', Name: 'Recent', IsActive: false, EndDate: '2023-01-01', ...prov }, since)).not.toBeNull();
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
