import { describe, it, expect } from 'vitest';
import { buildExtracts } from './queries.js';
import { loadConfig } from '../config.js';

describe('buildExtracts', () => {
  const byName = new Map(buildExtracts(loadConfig()).map((e) => [e.name, e]));
  it('pulls the Affiliation fields the Affiliations board needs', () => {
    const affil = buildExtracts(loadConfig()).find((e) => e.name === 'affiliations')!;
    const soql = affil.soql.replace(/\s+/g, ' ');
    for (const field of ['npe5__Role__c', 'npe5__Status__c', 'npe5__StartDate__c', 'npe5__EndDate__c',
      'npe5__Primary__c', 'npe5__Description__c', 'CreatedDate', 'CreatedBy.Name',
      'LastModifiedDate', 'LastModifiedBy.Name']) {
      expect(soql, field).toContain(field);
    }
    expect(affil.backupOnly).toBeFalsy();
  });
  it('promotes the Eventbrite (eb4sf) events and attendees to real extracts with the fields transform reads', () => {
    const events = byName.get('eb4sf_events')!;
    const attendees = byName.get('eb4sf_attendees')!;
    expect(events.backupOnly).toBeFalsy();
    expect(attendees.backupOnly).toBeFalsy();
    for (const f of ['eb4sf__Event_Name__c', 'eb4sf__Start__c', 'eb4sf__End__c', 'eb4sf__Status__c',
      'eb4sf__Event_URL__c', 'eb4sf__Organizer_Name__c', 'eb4sf__Total_Tickets_Sold__c',
      'eb4sf__Eventbrite_Venue__r.eb4sf__Name__c', 'eb4sf__Eventbrite_Venue__r.eb4sf__City__c',
      'eb4sf__Eventbrite_Venue__r.eb4sf__Localized_Address_Display__c']) {
      expect(events.soql, f).toContain(f);
    }
    for (const f of ['eb4sf__First_Name__c', 'eb4sf__Last_Name__c', 'eb4sf__Email__c', 'eb4sf__Status__c',
      'eb4sf__Checked_In__c', 'eb4sf__Cancelled__c', 'eb4sf__Ticket_Class_Name__c', 'eb4sf__Base_Price__c',
      'eb4sf__Contact__c', 'eb4sf__Eventbrite_Event__c']) {
      expect(attendees.soql, f).toContain(f);
    }
  });
  it('extracts the Funraise ticket name for the shared Ticket Type column', () => {
    expect(byName.get('registrations')!.soql).toContain('funraise__Ticket_Name__c');
  });
});
