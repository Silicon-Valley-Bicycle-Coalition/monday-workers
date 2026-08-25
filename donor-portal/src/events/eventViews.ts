import { escapeHtml } from '../views';
import type { EventRegistrationRecord } from '../types';
import type { EventRegistrationListing } from './loadEventRegistrations';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

// A registration whose Attendee matched but whose Event link didn't resolve (or was never set)
// still shows up — under its own registration item name, with a blank date.
function eventLabel(record: EventRegistrationRecord): string {
  return record.eventName !== '' ? record.eventName : record.registrationName;
}

// Attendance is only meaningful for past events (an upcoming event can't have been attended
// yet), so the upcoming table omits the status column entirely.
function registrationTable(records: EventRegistrationRecord[], locale: Locale, withStatus: boolean): string {
  const statusHeader = withStatus ? `<th>${escapeHtml(t(locale, 'events.tableStatus'))}</th>` : '';
  const rows = records
    .map((record) => {
      const statusCell = withStatus
        ? `<td>${escapeHtml(t(locale, record.attended ? 'events.statusAttended' : 'events.statusRegistered'))}</td>`
        : '';
      return `<tr><td>${escapeHtml(eventLabel(record))}</td><td>${escapeHtml(record.eventDate)}</td>${statusCell}</tr>`;
    })
    .join('');
  return `
    <table>
      <thead>
        <tr><th>${escapeHtml(t(locale, 'events.tableEvent'))}</th><th>${escapeHtml(t(locale, 'events.tableDate'))}</th>${statusHeader}</tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function donorSection(listing: EventRegistrationListing, locale: Locale): string {
  if (listing.upcoming.length === 0 && listing.past.length === 0) {
    return `<section><h2>${escapeHtml(listing.donorName)}</h2><p>${escapeHtml(t(locale, 'events.noneYet', { name: listing.donorName }))}</p></section>`;
  }
  const upcoming =
    listing.upcoming.length > 0
      ? `<h3>${escapeHtml(t(locale, 'events.upcomingHeading'))}</h3>${registrationTable(listing.upcoming, locale, false)}`
      : '';
  const past =
    listing.past.length > 0
      ? `<h3>${escapeHtml(t(locale, 'events.pastHeading'))}</h3>${registrationTable(listing.past, locale, true)}`
      : '';
  return `<section><h2>${escapeHtml(listing.donorName)}</h2>${upcoming}${past}</section>`;
}

export function eventsListView(listings: EventRegistrationListing[], locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'events.listHeading'))}</h1>
    ${listings.map((listing) => donorSection(listing, locale)).join('')}
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'events.backToPortal'))}</a></p>
  `;
}

export function eventsUnavailableView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'events.listHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'events.unavailable'))}</p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'events.backToPortal'))}</a></p>
  `;
}
