// The Events and Volunteering tabs: each person's event registrations (upcoming, then past) or
// volunteer history, then the Get involved links every member sees. Each section degrades on its
// own: a failed or unconfigured read hides that section, not the page.
import type { AppDeps } from '../routes';
import type { DonorVolunteerHistory, EventRegistrationRecord, GetInvolvedCategory, GetInvolvedLink } from '../types';
import { eventsEnabled } from '../config';
import { loadEventRegistrations, type EventRegistrationListing } from '../events/loadEventRegistrations';
import type { Locale } from '../i18n/locales';
import { t, type TranslationKey } from '../i18n/t';
import { errorText } from '../logSafe';
import { escapeHtml } from '../views';
import { formatShortDate } from '../dates';
import { emptyState, personGroup, tabPanel } from './layout';

const VOLUNTEER_CTA_URL = 'https://bikesiliconvalley.org/get-involved/volunteer';
const EVENTS_CTA_URL = 'https://bikesiliconvalley.org/events';

// The people the tabs group by, from the header's read: a person whose read failed is left out.
export interface TabPerson {
  id: string;
  name: string;
}

type EventsDeps = Pick<AppDeps, 'monday' | 'config' | 'now'>;

// The Events tab's one read of its own. null when the feature is off or the read failed: no
// registrations section at all, just Get involved.
export async function loadEventsTab(donorItemIds: string[], deps: EventsDeps): Promise<Record<string, EventRegistrationListing> | null> {
  if (!eventsEnabled(deps.config)) return null;
  try {
    const listings = await loadEventRegistrations(donorItemIds, deps.monday, deps.config.eventRegistrations, deps.now());
    return Object.fromEntries(listings.map((listing) => [listing.donorId, listing]));
  } catch (err) {
    console.error(`member-portal events load failed: ${errorText(err)}`);
    return null;
  }
}

function volunteerShiftRow(shift: DonorVolunteerHistory['shifts'][number]): string {
  return `
    <tr>
      <td>${escapeHtml(formatShortDate(shift.date))}</td>
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
      return `<tr><td>${escapeHtml(eventLabel(record))}</td><td>${escapeHtml(formatShortDate(record.eventDate))}</td>${statusCell}</tr>`;
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
function getInvolvedSection(links: GetInvolvedLink[], locale: Locale, categories: GetInvolvedCategory[]): string {
  const groups = GET_INVOLVED_GROUPS.filter((g) => categories.includes(g.category)).map(({ category, heading, fallbackLink }) => {
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
      ${categories.includes('civic') ? `<p>${escapeHtml(t(locale, 'portal.getInvolvedIntro'))}</p>` : ''}
      ${groups}
    </section>
  `;
}

export function eventsTabView(
  people: TabPerson[],
  household: boolean,
  events: Record<string, EventRegistrationListing> | null,
  links: GetInvolvedLink[],
  locale: Locale
): string {
  const groups = people
    .map((person) => {
      const listing = events?.[person.id];
      return listing ? personGroup(person.name, eventsPanel(listing, locale), household) : '';
    })
    .join('');
  const getInvolved = getInvolvedSection(links, locale, ['civic', 'transit', 'events']);
  const empty = groups === '' && getInvolved === '' ? `<p>${escapeHtml(t(locale, 'door.activityEmpty'))}</p>` : '';
  return tabPanel(t(locale, 'events.tabLabel'), `${groups}${getInvolved}${empty}`);
}

export function volunteeringTabView(
  people: TabPerson[],
  household: boolean,
  volunteer: Record<string, DonorVolunteerHistory> | null,
  links: GetInvolvedLink[],
  locale: Locale
): string {
  const groups = people
    .map((person) => {
      const history = volunteer?.[person.id];
      return history ? personGroup(person.name, volunteerPanel(history, locale), household) : '';
    })
    .join('');
  const getInvolved = getInvolvedSection(links, locale, ['volunteer']);
  const empty = groups === '' && getInvolved === '' ? `<p>${escapeHtml(t(locale, 'door.activityEmpty'))}</p>` : '';
  return tabPanel(t(locale, 'tabs.volunteering'), `${groups}${getInvolved}${empty}`);
}
