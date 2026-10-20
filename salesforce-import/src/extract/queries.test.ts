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
  it('extracts the eb4sf order behind each ticket gift, for the Eventbrite Order ID stamp', () => {
    const orders = byName.get('eb4sf_orders')!;
    expect(orders.backupOnly).toBeFalsy();
    for (const f of ['Name', 'eb4sf__Opportunity__c', 'FROM eb4sf__Eventbrite_Order__c']) expect(orders.soql, f).toContain(f);
  });
  it('paginates every object near the 50k CLI ceiling (contact roles ~54k, opportunities ~48k, payments/tasks ~42k)', () => {
    for (const name of ['contacts', 'accounts', 'opportunities', 'contact_roles', 'payments', 'tasks_all']) {
      expect(byName.get(name)!.paginate, name).toBe(true);
    }
  });
  it('keeps payments in the backup archive only and extracts contact roles for soft credits (issue #23)', () => {
    expect(byName.get('payments')!.backupOnly).toBe(true);
    const roles = byName.get('contact_roles')!;
    expect(roles.backupOnly).toBeFalsy();
    for (const f of ['OpportunityId', 'ContactId', 'Role']) expect(roles.soql, f).toContain(f);
  });
  it('never paginates a query runSoqlPaginated would reject (it appends its own WHERE/ORDER BY/LIMIT)', () => {
    for (const ex of byName.values()) {
      if (ex.paginate) expect(ex.soql, ex.name).not.toMatch(/\b(WHERE|ORDER BY|LIMIT)\b/i);
    }
  });
  it('selects Elected__c so transform can seed Stakeholder Type = Elected Official (#46)', () => {
    expect(byName.get('contacts')!.soql).toContain('Elected__c');
  });
  it('extracts the Funraise ticket name for the shared Ticket Type column', () => {
    expect(byName.get('registrations')!.soql).toContain('funraise__Ticket_Name__c');
  });
  it('keeps the sponsorship cluster and BTWD logistics objects backup-only (migration #53, 2026-09-30)', () => {
    // Decided never to migrate to a board; the archive must still hold every custom field.
    const expected: Record<string, string[]> = {
      sponsorship_levels: ['FROM Sponsorship_Level__c', 'RecordType.Name', 'Logo_on_SVBC_Jersey__c', 'X25_One_year_complimentary_memberships__c'],
      sponsorship_packages: ['FROM Sponsorship_Package__c', 'Account__c', 'Opportunity__c', 'Sponsorship_Level__c'],
      sponsor_benefits: ['FROM Sponsor_Benefit__c', 'Benefit__c', 'Sponsorship_Package__c', 'Available__c', 'Redeemed__c'],
      benefits: ['FROM Benefit__c', 'Available__c', 'Campaign__c'],
      btwd_orders: ['FROM BTWD_Order__c', 'RecordType.Name', 'Energizer_Station__c', 'Total_of_Shirts__c', 'Poster_Order_Status__c'],
      energizer_stations: ['FROM Energizer_Station__c', 'Host_Organization__c', 'Energizer_Station_Lead__c', 'Status__c', 'Location_City__c'],
    };
    for (const [name, fields] of Object.entries(expected)) {
      const ex = byName.get(name);
      expect(ex, name).toBeDefined();
      expect(ex!.backupOnly, name).toBe(true);
      // ~2,046 sponsorship rows and ~1,081 BTWD rows in total — nowhere near the 50k ceiling.
      expect(ex!.paginate, name).toBeFalsy();
      const soql = ex!.soql.replace(/\s+/g, ' ');
      for (const f of ['Id', 'Name', 'CreatedDate', 'LastModifiedDate', ...fields]) expect(soql, `${name}.${f}`).toContain(f);
    }
  });
});
