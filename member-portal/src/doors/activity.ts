// The rides, events & volunteering door: each person's event registrations (upcoming, then past)
// and volunteer history, then the Get involved links every member sees. Each section degrades on
// its own: a failed or unconfigured read hides that section, not the page.
import type { AppDeps } from '../routes';
import type { DonorVolunteerHistory, EventRegistrationRecord, GetInvolvedCategory, GetInvolvedLink } from '../types';
import { eventsEnabled, volunteerHistoryEnabled } from '../config';
import { loadPortalData } from '../portal/loadPortalData';
import { loadEventRegistrations, type EventRegistrationListing } from '../events/loadEventRegistrations';
import type { Locale } from '../i18n/locales';
import { t, type TranslationKey } from '../i18n/t';
import { errorText } from '../logSafe';
import { escapeHtml, someRecordsUnavailableNote } from '../views';
import { doorPage, emptyState, personGroup } from './layout';

const VOLUNTEER_CTA_URL = 'https://bikesiliconvalley.org/get-involved/volunteer';
const EVENTS_CTA_URL = 'https://bikesiliconvalley.org/events';

export interface ActivityDoorData {
  // In session order; a person whose read failed is left out and counted below.
  people: { id: string; name: string }[];
  unavailableCount: number;
  // Keyed by donor id. null when the feature is off or its read failed: no section at all.
  events: Record<string, EventRegistrationListing> | null;
  volunteer: Record<string, DonorVolunteerHistory> | null;
  getInvolved: GetInvolvedLink[];
}

type ActivityDeps = Pick<AppDeps, 'monday' | 'config' | 'now'>;

export async function loadActivityDoor(donorItemIds: string[], deps: ActivityDeps): Promise<ActivityDoorData> {
  // Started first and awaited after (GL#99): independent of the people read, with the catch
  // attached up front so a rejection is never unhandled when that read throws.
  const eventsLeg: Promise<Record<string, EventRegistrationListing> | null> = eventsEnabled(deps.config)
    ? loadEventRegistrations(donorItemIds, deps.monday, deps.config.eventRegistrations, deps.now()).then(
        (listings) => Object.fromEntries(listings.map((listing) => [listing.donorId, listing])),
        (err: unknown) => {
          console.error(`member-portal activity events load failed: ${errorText(err)}`);
          return null;
        }
      )
    : Promise.resolve(null);

  // Names (for household grouping) and volunteer history, which degrades to null on its own.
  // Throws only when no one loads (the route's error page).
  const data = await loadPortalData(
    donorItemIds,
    deps.monday,
    { enabled: volunteerHistoryEnabled(deps.config), completedStatuses: deps.config.volunteerHistory.completedStatuses },
    false,
    { discounts: false }
  );
  const events = await eventsLeg;

  return {
    people: data.donors.map((donor) => ({ id: donor.id, name: donor.name })),
    unavailableCount: data.unavailableDonorCount ?? 0,
    events,
    volunteer: data.volunteerHistory,
    getInvolved: deps.config.getInvolved.links,
  };
}

function volunteerShiftRow(shift: DonorVolunteerHistory['shifts'][number]): string {
  return `
    <tr>
      <td>${escapeHtml(shift.date)}</td>
      <td>${escapeHtml(shift.job)}</td>
      <td>${escapeHtml(shift.hours)}</td>
    </tr>
  `;
}

function volunteerPanel(history: DonorVolunteerHistory, locale: Locale): string {
  if (history.shifts.length === 0) {
    return emptyState('portal.volunteerEmptyMessage', VOLUNTEER_CTA_URL, 'portal.volunteerButton', locale);
  }
  const rows = history.shifts.map(volunteerShiftRow).join('');
  return `
    <p>${escapeHtml(t(locale, 'portal.volunteerTotalHours', { hours: String(history.totalHours) }))}</p>
    <table>
      <thead>
        <tr><th>${escapeHtml(t(locale, 'portal.tableDate'))}</th><th>${escapeHtml(t(locale, 'portal.volunteerTableActivity'))}</th><th>${escapeHtml(t(locale, 'portal.volunteerTableHours'))}</th></tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

// A registration whose Attendee matched but whose Event link didn't resolve (or was never set)
// still shows up — under its own registration item name, with a blank date.
function eventLabel(record: EventRegistrationRecord): string {
  return record.eventName !== '' ? record.eventName : record.registrationName;
}

// Attendance is only meaningful for past events, so the upcoming table has no status column.
function eventRegistrationTable(records: EventRegistrationRecord[], locale: Locale, withStatus: boolean): string {
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

function eventsPanel(listing: Pick<EventRegistrationListing, 'upcoming' | 'past'>, locale: Locale): string {
  if (listing.upcoming.length === 0 && listing.past.length === 0) {
    return emptyState('events.emptyMessage', EVENTS_CTA_URL, 'events.findEventsButton', locale);
  }
  const upcoming =
    listing.upcoming.length > 0
      ? `<h4>${escapeHtml(t(locale, 'events.upcomingHeading'))}</h4>${eventRegistrationTable(listing.upcoming, locale, false)}`
      : '';
  const past =
    listing.past.length > 0 ? `<h4>${escapeHtml(t(locale, 'events.pastHeading'))}</h4>${eventRegistrationTable(listing.past, locale, true)}` : '';
  return `${upcoming}${past}`;
}

// Category order and copy for getInvolvedSection. `fallbackLink` is the link text for a link
// with no configured label (events/volunteer); config validation requires a label on the others.
const GET_INVOLVED_GROUPS: { category: GetInvolvedCategory; heading: TranslationKey; fallbackLink?: TranslationKey }[] = [
  { category: 'civic', heading: 'portal.getInvolvedCivic' },
  { category: 'transit', heading: 'portal.getInvolvedTransit' },
  { category: 'events', heading: 'portal.getInvolvedEvents', fallbackLink: 'portal.getInvolvedEventsLink' },
  { category: 'volunteer', heading: 'portal.getInvolvedVolunteer', fallbackLink: 'portal.getInvolvedVolunteerLink' },
];

// Public meeting, event, and volunteer links from config's getInvolved.links — the same for
// every member. A category with no links is skipped; no links at all omits the section.
function getInvolvedSection(links: GetInvolvedLink[], locale: Locale): string {
  const groups = GET_INVOLVED_GROUPS.map(({ category, heading, fallbackLink }) => {
    const rows = links
      .filter((link) => link.category === category)
      .map((link) => {
        const text = link.label ?? (fallbackLink === undefined ? link.url : t(locale, fallbackLink));
        const calendar =
          link.calendarUrl === undefined
            ? ''
            : ` · <a href="${escapeHtml(link.calendarUrl)}" rel="noopener noreferrer">${escapeHtml(t(locale, 'portal.addToCalendar'))}</a>`;
        return `<li><a href="${escapeHtml(link.url)}" rel="noopener noreferrer">${escapeHtml(text)}</a>${calendar}</li>`;
      })
      .join('');
    return rows === '' ? '' : `<h3>${escapeHtml(t(locale, heading))}</h3><ul>${rows}</ul>`;
  }).join('');
  if (groups === '') return '';
  return `
    <section>
      <h2>${escapeHtml(t(locale, 'portal.getInvolvedHeading'))}</h2>
      <p>${escapeHtml(t(locale, 'portal.getInvolvedIntro'))}</p>
      ${groups}
    </section>
  `;
}

export function activityDoorView(data: ActivityDoorData, locale: Locale): string {
  const household = data.people.length + data.unavailableCount > 1;
  const groups = data.people
    .map((person) => {
      const listing = data.events?.[person.id];
      const history = data.volunteer?.[person.id];
      const events = listing ? `<h3>${escapeHtml(t(locale, 'events.tabLabel'))}</h3>${eventsPanel(listing, locale)}` : '';
      const volunteer = history ? `<h3>${escapeHtml(t(locale, 'portal.volunteerHeading'))}</h3>${volunteerPanel(history, locale)}` : '';
      const body = `${events}${volunteer}`;
      return body === '' ? '' : personGroup(person.name, body, household);
    })
    .join('');
  const getInvolved = getInvolvedSection(data.getInvolved, locale);
  const empty = groups === '' && getInvolved === '' ? `<p>${escapeHtml(t(locale, 'door.activityEmpty'))}</p>` : '';
  return doorPage(t(locale, 'home.doorActivity'), `${someRecordsUnavailableNote(data.unavailableCount, locale)}${groups}${getInvolved}${empty}`, locale);
}
