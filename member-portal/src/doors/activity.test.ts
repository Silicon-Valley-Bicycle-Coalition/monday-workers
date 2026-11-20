import { describe, it, expect } from 'vitest';
import { eventsTabView, volunteeringTabView } from './activity';
import type { GetInvolvedLink } from '../types';
import { t } from '../i18n/t';
import { escapeHtml } from '../views';

const jane = { id: 'donor-1', name: 'Jane Donor' };
const also = { id: 'donor-2', name: 'Jane Also' };

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

describe('eventsTabView', () => {
  it('shows upcoming and past registrations, with attendance on past ones only', () => {
    const html = eventsTabView([jane], false, { 'donor-1': listing }, [], 'en');
    expect(html).toContain(`<h1 class="visually-hidden">${escapeHtml(t('en', 'events.tabLabel'))}</h1>`);
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

  it('invites someone with no registrations to find an event, with no gold button', () => {
    const html = eventsTabView([jane], false, { 'donor-1': { ...listing, upcoming: [], past: [] } }, [], 'en');
    expect(html).toContain(t('en', 'events.emptyMessage'));
    expect(html).toContain(t('en', 'events.findEventsButton'));
    expect(html).toContain('href="https://bikesiliconvalley.org/events"');
    expect(html).not.toContain('cta-button');
  });

  it('shows Get involved when the events read failed (events null), without volunteer links', () => {
    const html = eventsTabView([jane], false, null, links, 'en');
    expect(html).not.toContain(t('en', 'events.upcomingHeading'));
    expect(html).toContain(t('en', 'portal.getInvolvedHeading'));
    expect(html).toContain(t('en', 'portal.getInvolvedCivic'));
    expect(html).toContain('href="https://cal.example/bpac.ics"');
    expect(html).not.toContain(t('en', 'portal.getInvolvedVolunteerLink'));
    expect(html).not.toContain(t('en', 'portal.getInvolvedTransit'));
  });

  it('says there is nothing to show when every section is off', () => {
    expect(eventsTabView([jane], false, null, [], 'en')).toContain(t('en', 'door.activityEmpty'));
  });

  it('groups a household under names and escapes record text', () => {
    const html = eventsTabView(
      [jane, { id: 'donor-2', name: '<b>Sam</b>' }],
      true,
      {
        'donor-1': { ...listing, upcoming: [{ registrationName: 'r', eventName: '<script>alert(1)</script>', eventDate: '2026-10-03', attended: false }], past: [] },
        'donor-2': { ...listing, donorId: 'donor-2', upcoming: [], past: [] },
      },
      [],
      'en'
    );
    expect(html).toContain('<h2>Jane Donor</h2>');
    expect(html).toContain('<h2>&lt;b&gt;Sam&lt;/b&gt;</h2>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('puts city committees before transit agencies and escapes labels and URLs', () => {
    const html = eventsTabView(
      [jane],
      false,
      null,
      [
        { category: 'transit', label: 'BART <b>BATF</b>', url: 'https://bart.example/?a=1&b=2' },
        { category: 'civic', label: 'San José BPAC', url: 'https://sj.example/bpac' },
      ],
      'es'
    );
    expect(html.indexOf(t('es', 'portal.getInvolvedCivic'))).toBeLessThan(html.indexOf(t('es', 'portal.getInvolvedTransit')));
    expect(html).toContain('BART &lt;b&gt;BATF&lt;/b&gt;');
    expect(html).toContain('href="https://bart.example/?a=1&amp;b=2"');
  });
});

describe('volunteeringTabView', () => {
  it('shows volunteer history without a total, and a volunteer prompt for someone with none', () => {
    const html = volunteeringTabView(
      [jane, also],
      true,
      {
        'donor-1': { shifts: [{ date: '2026-03-05', hours: '3.5', job: 'Bike Valet', status: 'Completed' }], totalHours: 3.5 },
        'donor-2': { shifts: [], totalHours: 0 },
      },
      [],
      'en'
    );
    expect(html).toContain(`<h1 class="visually-hidden">${escapeHtml(t('en', 'tabs.volunteering'))}</h1>`);
    expect(html).toContain('Bike Valet');
    // The total is in the header's Hours volunteered stat, not repeated here.
    expect(html).not.toContain('Total volunteer hours');
    const second = html.slice(html.indexOf('<h2>Jane Also</h2>'));
    expect(second).toContain(t('en', 'portal.volunteerEmptyMessage'));
    expect(second).toContain('href="https://bikesiliconvalley.org/get-involved/volunteer"');
    expect(html).not.toContain('cta-button');
  });

  it('lists only the volunteer Get involved links, with the fallback link text and no meetings intro', () => {
    const html = volunteeringTabView([jane], false, null, links, 'en');
    expect(html).toContain(t('en', 'portal.getInvolvedVolunteerLink'));
    expect(html).not.toContain('San José BPAC');
    expect(html).not.toContain(t('en', 'portal.getInvolvedIntro'));
  });

  it('says there is nothing to show when volunteer history is off and there are no links', () => {
    expect(volunteeringTabView([jane], false, null, [], 'en')).toContain(t('en', 'door.activityEmpty'));
  });
});
