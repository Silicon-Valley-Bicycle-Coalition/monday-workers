import { describe, it, expect } from 'vitest';
import { activityDoorView, type ActivityDoorData } from './activity';
import type { GetInvolvedLink } from '../types';
import { t } from '../i18n/t';
import { escapeHtml } from '../views';

const jane = { id: 'donor-1', name: 'Jane Donor' };
const also = { id: 'donor-2', name: 'Jane Also' };

function data(overrides: Partial<ActivityDoorData> = {}): ActivityDoorData {
  return { people: [jane], unavailableCount: 0, events: null, volunteer: null, getInvolved: [], ...overrides };
}

const listing = {
  donorId: 'donor-1',
  donorName: 'Jane Donor',
  upcoming: [{ registrationName: 'reg-1', eventName: 'Fall Gala', eventDate: '2026-10-03', attended: false }],
  past: [
    { registrationName: 'reg-2', eventName: 'Spring Ride', eventDate: '2026-03-01', attended: true },
    { registrationName: 'reg-3', eventName: '', eventDate: '', attended: false },
  ],
};

const links: GetInvolvedLink[] = [
  { category: 'civic', label: 'San José BPAC', url: 'https://sj.example/bpac', calendarUrl: 'https://cal.example/bpac.ics' },
  { category: 'volunteer', url: 'https://svbc.example/volunteer' },
];

describe('activityDoorView', () => {
  it('shows upcoming and past registrations, with attendance on past ones only', () => {
    const html = activityDoorView(data({ events: { 'donor-1': listing } }), 'en');
    expect(html).toContain(`<h1>${escapeHtml(t('en', 'home.doorActivity'))}</h1>`);
    expect(html).toContain(t('en', 'events.upcomingHeading'));
    expect(html).toContain(t('en', 'events.pastHeading'));
    expect(html).toContain('Fall Gala');
    expect(html).toContain('Spring Ride');
    expect(html).toContain(`<td>${t('en', 'events.statusAttended')}</td>`);
    // An unresolved event link falls back to the registration's own name.
    expect(html).toContain('<td>reg-3</td>');
    const upcoming = html.slice(html.indexOf(t('en', 'events.upcomingHeading')), html.indexOf(t('en', 'events.pastHeading')));
    expect(upcoming).not.toContain(t('en', 'events.tableStatus'));
  });

  it('invites someone with no registrations to find an event', () => {
    const html = activityDoorView(data({ events: { 'donor-1': { ...listing, upcoming: [], past: [] } } }), 'en');
    expect(html).toContain(t('en', 'events.emptyMessage'));
    expect(html).toContain(t('en', 'events.findEventsButton'));
    expect(html).toContain('href="https://bikesiliconvalley.org/events"');
  });

  it('shows volunteer history with total hours, and a volunteer prompt for someone with none', () => {
    const html = activityDoorView(
      data({
        people: [jane, also],
        volunteer: {
          'donor-1': { shifts: [{ date: '2026-03-05', hours: '3.5', job: 'Bike Valet', status: 'Completed' }], totalHours: 3.5 },
          'donor-2': { shifts: [], totalHours: 0 },
        },
      }),
      'en'
    );
    expect(html).toContain(t('en', 'portal.volunteerHeading'));
    expect(html).toContain('Bike Valet');
    expect(html).toContain(t('en', 'portal.volunteerTotalHours', { hours: '3.5' }));
    const second = html.slice(html.indexOf('<h2>Jane Also</h2>'));
    expect(second).toContain(t('en', 'portal.volunteerEmptyMessage'));
    expect(second).toContain('href="https://bikesiliconvalley.org/get-involved/volunteer"');
  });

  it('renders the other sections when the events read failed (events null)', () => {
    const html = activityDoorView(
      data({
        events: null,
        volunteer: { 'donor-1': { shifts: [{ date: '2026-03-05', hours: '2', job: 'Tabling', status: 'Completed' }], totalHours: 2 } },
        getInvolved: links,
      }),
      'en'
    );
    expect(html).not.toContain(t('en', 'events.upcomingHeading'));
    expect(html).not.toContain(t('en', 'events.emptyMessage'));
    expect(html).toContain('Tabling');
    expect(html).toContain(t('en', 'portal.getInvolvedHeading'));
  });

  it('lists the Get involved links by category, with calendar links and the fallback link text', () => {
    const html = activityDoorView(data({ getInvolved: links }), 'en');
    expect(html).toContain(t('en', 'portal.getInvolvedCivic'));
    expect(html).toContain('href="https://sj.example/bpac"');
    expect(html).toContain('San José BPAC');
    expect(html).toContain('href="https://cal.example/bpac.ics"');
    expect(html).toContain(t('en', 'portal.getInvolvedVolunteerLink'));
    expect(html).not.toContain(t('en', 'portal.getInvolvedTransit'));
  });

  it('makes no empty-state link a gold button: those are for the home page and Donate', () => {
    const html = activityDoorView(
      data({ events: { 'donor-1': { ...listing, upcoming: [], past: [] } }, volunteer: { 'donor-1': { shifts: [], totalHours: 0 } } }),
      'en'
    );
    expect(html).not.toContain('cta-button');
  });

  it('says there is nothing to show when every section is off', () => {
    const html = activityDoorView(data(), 'en');
    expect(html).toContain(t('en', 'door.activityEmpty'));
  });

  it('groups a household under names and escapes record text', () => {
    const html = activityDoorView(
      data({
        people: [jane, { id: 'donor-2', name: '<b>Sam</b>' }],
        events: { 'donor-1': { ...listing, upcoming: [{ registrationName: 'r', eventName: '<script>alert(1)</script>', eventDate: '2026-10-03', attended: false }], past: [] } },
        volunteer: { 'donor-2': { shifts: [], totalHours: 0 } },
      }),
      'en'
    );
    expect(html).toContain('<h2>Jane Donor</h2>');
    expect(html).toContain('<h2>&lt;b&gt;Sam&lt;/b&gt;</h2>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('type="radio"');
  });

  it('tells the member when some records could not be loaded', () => {
    expect(activityDoorView(data({ unavailableCount: 1, getInvolved: links }), 'en')).toContain(t('en', 'portal.someRecordsUnavailable'));
  });

  it('puts city committees before transit agencies and escapes labels and URLs', () => {
    const html = activityDoorView(
      data({
        getInvolved: [
          { category: 'transit', label: 'BART <b>BATF</b>', url: 'https://bart.example/?a=1&b=2' },
          { category: 'civic', label: 'San José BPAC', url: 'https://sj.example/bpac' },
        ],
      }),
      'es'
    );
    expect(html.indexOf(t('es', 'portal.getInvolvedCivic'))).toBeLessThan(html.indexOf(t('es', 'portal.getInvolvedTransit')));
    expect(html).toContain('BART &lt;b&gt;BATF&lt;/b&gt;');
    expect(html).toContain('href="https://bart.example/?a=1&amp;b=2"');
    expect(html).toContain(t('es', 'portal.getInvolvedHeading'));
  });
});

