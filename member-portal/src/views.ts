import type {
  DiscountOrganization,
  DonorImpact,
  DonorVolunteerHistory,
  EventRegistrationRecord,
  FunraiseLinkUrls,
  GetInvolvedCategory,
  GetInvolvedLink,
  PortalView,
} from './types';
import { SUPPORTED_LOCALES, LOCALE_NATIVE_LABELS, type Locale } from './i18n/locales';
import { t, type TranslationKey } from './i18n/t';
import { LOGO_SVG_ASSET, PORTAL_CSS_ASSET } from './assets/static';
import { formatUsdText } from './money';
import { formatShortDate } from './dates';
import { parseAmount } from './amounts';
import type { PortalCard } from './card/loadCardData';
// Type-only: eventViews.ts imports escapeHtml from this module, so a runtime import back from
// there would be circular. The (small) event-table rendering below is duplicated rather than
// shared for the same reason — see the comment on eventsPanel.
import type { EventRegistrationListing } from './events/loadEventRegistrations';

// Brand chrome constants — same values as config/svbc.json's taxLetter.orgLegalName /
// officeAddress / mailingAddress / ein, duplicated here (rather than threaded through every
// page() call site) because this is footer branding copy, not operational config. Keep in sync
// if the org's legal name, addresses, EIN, or these URLs change.
const ORG_NAME = 'Silicon Valley Bicycle Coalition';
const ORG_ADDRESS = '95 S Market St, Suite 648, San José, CA 95113';
const ORG_MAILING_ADDRESS = 'PO Box 1927, San José, CA 95109';
const ORG_EIN = '77-0338658';
const ORG_WEBSITE_URL = 'https://bikesiliconvalley.org';
const ORG_DONATE_URL = 'https://bikesiliconvalley.org/ways-to-give';
const VOLUNTEER_CTA_URL = 'https://bikesiliconvalley.org/get-involved/volunteer';
const EVENTS_CTA_URL = 'https://bikesiliconvalley.org/events';
const ORG_PRIVACY_POLICY_URL = 'https://siliconvalleybicyclecoaliti.app.box.com/s/1diyqeoe5dcsfsg0qx2yk7oa539toz35';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The SVBC wordmark, served from its content-hashed immutable route (see assets/static.ts) rather
// than inlined into every no-store page. width/height mirror the SVG's own, so the browser has
// the intrinsic aspect ratio before the file loads and CSS can set only a height. The org name
// is a proper noun, so the alt text isn't translated.
function logoImg(className?: string): string {
  const cls = className ? ` class="${className}"` : '';
  return `<img${cls} src="${LOGO_SVG_ASSET.path}" width="235" height="90" alt="Silicon Valley Bicycle Coalition" />`;
}

function siteHeader(locale: Locale, authenticated: boolean): string {
  const logoutForm = authenticated
    ? `<form class="logout-form" action="/logout" method="post"><button type="submit">${escapeHtml(t(locale, 'portal.logout'))}</button></form>`
    : '';
  return `<header class="site-header">
    <div class="site-header-inner">
      <a class="site-header-logo-link" href="${ORG_WEBSITE_URL}" target="_blank" rel="noopener noreferrer">${logoImg('site-logo')}</a>
      <div class="site-header-right">
        ${logoutForm}
        <a class="site-header-donate" href="${ORG_DONATE_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(locale, 'nav.donate'))}</a>
      </div>
    </div>
  </header>`;
}

// Shared by every page (pre-identity and authenticated alike): basic org contact info plus a
// language <select> that auto-submits on change — it fills the hidden `to` field with the
// browser's actual current location.pathname right before submitting, so switching language
// returns the visitor to wherever they were without this needing to be threaded through every
// page() call site. No visible submit button: a no-JS visitor can't change the value via this
// <select> in the first place, so there's nothing for a fallback button to submit either.
function siteFooter(locale: Locale, languagePicker: boolean): string {
  const options = SUPPORTED_LOCALES.map(
    (code) => `<option value="${code}"${code === locale ? ' selected' : ''}>${escapeHtml(LOCALE_NATIVE_LABELS[code])}</option>`
  ).join('');
  return `
    <footer class="site-footer">
      <div class="site-footer-inner">
        <div class="site-footer-contact">
          <p>${escapeHtml(ORG_NAME)}</p>
          <p>${escapeHtml(ORG_ADDRESS)}</p>
          <p>${escapeHtml(t(locale, 'footer.nonprofit'))} &middot; ${escapeHtml(t(locale, 'footer.ein', { ein: ORG_EIN }))}</p>
          <p>${escapeHtml(t(locale, 'footer.mailingAddress'))} ${escapeHtml(ORG_MAILING_ADDRESS)}</p>
          <p>
            <a href="${ORG_WEBSITE_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(ORG_WEBSITE_URL.replace('https://', ''))}</a>
            &middot;
            <a href="${ORG_PRIVACY_POLICY_URL}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(locale, 'footer.privacyPolicy'))}</a>
          </p>
        </div>
        ${
          languagePicker
            ? `<form class="site-footer-lang" action="/lang" method="get" aria-label="${escapeHtml(t(locale, 'languagePicker.label'))}">
          <input type="hidden" name="to" value="" />
          <select name="code" onchange="this.form.to.value = location.pathname; this.form.submit()">${options}</select>
        </form>`
            : ''
        }
      </div>
    </footer>
  `;
}

// Wraps a view's HTML fragment in a minimal document so the browser has a real <title> and
// viewport meta — without it, browsers fall back to printing the bare URL in default print
// headers/footers, which is how the tax letter page used to print (see letterViews.letterView).
// `authenticated` shows the shared header's logout button — every route inside the session-gated
// /:locale/portal* tree passes true; the pre-identity and public /verify routes leave it false.
// languagePicker: false drops the footer language <select> — for pages whose state lives in the
// query string, which the picker's `to` (location.pathname only) would lose. GET /auth/callback
// is the one: switching language there dropped the token and landed on "invalid link".
export function page(
  title: string,
  body: string,
  locale: Locale,
  options: { authenticated?: boolean; languagePicker?: boolean } = {}
): string {
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/favicon.png" type="image/png" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="${PORTAL_CSS_ASSET.path}" />
  </head>
  <body>
    ${siteHeader(locale, options.authenticated ?? false)}
    <main>${body}</main>
    ${siteFooter(locale, options.languagePicker ?? true)}
  </body>
</html>`;
}

// Shared by the authenticated sub-pages (pledges, matching gifts; older views predate it and
// still inline the same markup — fold them in when next touched).
export function backToPortalLink(locale: Locale): string {
  return `<p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>`;
}

export function loginFormView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'login.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'login.prompt'))}</p>
    <form action="/" method="post">
      <input type="email" name="email" required />
      <button type="submit">${escapeHtml(t(locale, 'login.submit'))}</button>
    </form>
  `;
}

export function checkEmailView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'checkEmail.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'checkEmail.body'))}</p>
  `;
}

// GET /auth/callback's body (issue #31): a plain button that POSTs the magic-link token back,
// because mail scanners prefetch links and a GET that consumed the single-use token burned it
// before the donor clicked. Deliberately no script, no autofocus, no auto-submit — scanners that
// execute JS must not be able to complete the login. `lang` is only emitted when it's a
// supported locale (the caller validates), so nothing attacker-shaped is reflected besides the
// escaped token.
// Issue #61: new links carry the token in the URL fragment, which the browser never sends, so
// this copies it into the confirm form and drops it from the address bar and history. It only
// fills the form, never submits it: mail scanners that run a page's JS would otherwise burn the
// single-use token (issue #31). With no token in the fragment it swaps in the invalid-link copy.
// Served under a CSP pinning this exact text by hash (routes.ts), so edit it freely but only here.
export const CONFIRM_LOGIN_SCRIPT = `(function () {
  var match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (match) {
    document.getElementById('confirm-token').value = match[1];
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    document.getElementById('confirm-login').hidden = true;
    document.getElementById('confirm-invalid').hidden = false;
  }
})();`;

// token is null for a fragment link (CONFIRM_LOGIN_SCRIPT fills it in), or the token from a
// legacy ?token= link, sent before issue #61, which renders as before with no script.
export function confirmLoginView(token: string | null, lang: Locale | null, locale: Locale): string {
  const langField = lang === null ? '' : `\n      <input type="hidden" name="lang" value="${escapeHtml(lang)}" />`;
  const form = `
    <h1>${escapeHtml(t(locale, 'confirmLogin.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'confirmLogin.body'))}</p>
    <form action="/auth/callback" method="post">
      <input type="hidden" name="token" value="${escapeHtml(token ?? '')}"${token === null ? ' id="confirm-token"' : ''} />${langField}
      <button type="submit">${escapeHtml(t(locale, 'confirmLogin.submit'))}</button>
    </form>
  `;
  if (token !== null) return form;
  // Without JS the form posts an empty token, which the POST answers with the invalid-link page.
  return `
    <div id="confirm-login">${form}</div>
    <div id="confirm-invalid" hidden>${errorView('error.invalidLink', locale)}</div>
    <script>${CONFIRM_LOGIN_SCRIPT}</script>
  `;
}

export function errorView(messageKey: TranslationKey, locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'error.heading'))}</h1>
    <p>${escapeHtml(t(locale, messageKey))}</p>
    <p><a href="/">${escapeHtml(t(locale, 'error.requestNewLink'))}</a></p>
  `;
}

// The write switch is off or held (src/writeSwitch.ts): a POST that would write renders this with
// a 503. A signed-in donor gets a way back to the dashboard, which still works.
export function unavailableView(locale: Locale, authenticated: boolean): string {
  const back = authenticated ? `<p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>` : '';
  return `
    <h1>${escapeHtml(t(locale, 'unavailable.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'unavailable.body'))}</p>
    ${back}
  `;
}

function donationRow(donation: PortalView['donors'][number]['donations'][number], locale: Locale): string {
  return `
    <tr>
      <td>${escapeHtml(formatShortDate(donation.date))}</td>
      <td class="col-amount">${escapeHtml(formatUsdText(donation.amount))}</td>
      <td>${escapeHtml(donation.description)}${matchLine(donation, locale)}</td>
    </tr>
  `;
}

// Under the description: the paired employer match, or (for a gift still waiting on the donor) a
// link to start one. Every interpolated value is escaped; the link opens the donor's own DTD page.
function matchLine(donation: PortalView['donors'][number]['donations'][number], locale: Locale): string {
  if (donation.match) {
    const text = t(locale, 'portal.matchedBy', {
      company: donation.match.company,
      date: formatShortDate(donation.match.date),
      amount: formatUsdText(donation.match.amount),
    });
    return `<div class="match-line">${escapeHtml(text)}</div>`;
  }
  if (donation.matchHintUrl) {
    return `<div class="match-line"><a href="${escapeHtml(donation.matchHintUrl)}" target="_blank" rel="noopener">${escapeHtml(t(locale, 'portal.startMatch'))}</a></div>`;
  }
  return '';
}

// One tab of a donor's dashboard section. `label` is pre-translated (not a TranslationKey)
// since the Volunteer tab reuses portal.volunteerHeading's text as-is rather than adding a
// second, near-duplicate key.
interface DonorTab {
  label: string;
  content: string;
  // When this is the only tab, the tab strip (and so its label) is skipped — render the label
  // as a heading instead. Off for donations, whose table is self-explanatory as the section's
  // sole content; on for volunteer/events, which read as an unlabeled table without it.
  headingWhenAlone?: boolean;
}

// A single tab (today's overwhelmingly common case — most donors have neither volunteered nor
// registered for an event) renders its content directly with no tab chrome at all. Two or three
// tabs get the CSS-only radio/label widget (see .tabs in STYLE); the wrapper only ever needs to
// know how many tabs there are, not which ones, so the same three :nth-of-type rules in STYLE
// cover every combination.
function renderTabs(tabs: DonorTab[], groupName: string): string {
  const only = tabs[0];
  if (!only) return '';
  if (tabs.length === 1) {
    return only.headingWhenAlone ? `<h3>${escapeHtml(only.label)}</h3>${only.content}` : only.content;
  }
  const safeGroup = escapeHtml(groupName);
  const inputs = tabs
    .map(
      (tab, i) =>
        `<input type="radio" class="tab-input" name="${safeGroup}" id="${safeGroup}-${i}"${i === 0 ? ' checked' : ''}>` +
        `<label class="tab-label" for="${safeGroup}-${i}">${escapeHtml(tab.label)}</label>`
    )
    .join('');
  const panels = tabs.map((tab) => `<div class="tab-panel">${tab.content}</div>`).join('');
  return `<div class="tabs">${inputs}${panels}</div>`;
}

// A generic empty-state: a short message plus an external CTA button. Used by all three tabs —
// SVBC would rather every donor see an invitation to donate/volunteer/register than a bare empty
// table, so "no entries" always means a CTA, never a silently blank panel.
function emptyStateTab(messageKey: TranslationKey, url: string, buttonLabelKey: TranslationKey, locale: Locale): string {
  return `
    <div class="tab-empty">
      <p>${escapeHtml(t(locale, messageKey))}</p>
      <a class="cta-button" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(locale, buttonLabelKey))}</a>
    </div>
  `;
}

// Donations panel: the itemized table when there's something to show, otherwise a Donate CTA.
// "Something to show" is donations.length > 0 OR a nonzero totalDonated — a donor can have a
// nonzero lifetime rollup with no itemized rows on file (e.g. older gifts never synced as line
// items), and that donor has clearly already given, so a "you haven't donated yet" CTA would be
// wrong for them even though their itemized list is empty.
function donationsPanel(donor: PortalView['donors'][number], locale: Locale): string {
  const hasDonations = donor.donations.length > 0 || (parseAmount(donor.totalDonated) ?? 0) !== 0;
  if (!hasDonations) {
    return emptyStateTab('portal.donationsEmptyMessage', ORG_DONATE_URL, 'portal.donateButton', locale);
  }
  return `
    <table>
      <thead>
        <tr><th>${escapeHtml(t(locale, 'portal.tableDate'))}</th><th class="col-amount">${escapeHtml(t(locale, 'portal.tableAmount'))}</th><th>${escapeHtml(t(locale, 'portal.tableDescription'))}</th></tr>
      </thead>
      <tbody>
        ${donor.donations.map((d) => donationRow(d, locale)).join('')}
      </tbody>
      <tfoot>
        <tr>
          <td>${escapeHtml(t(locale, 'portal.totalLabel'))}</td>
          <td class="col-amount">${escapeHtml(formatUsdText(donor.totalDonated))}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  `;
}

// Single-sided wallet card — no flip, no back face (an earlier flip-card design was scrapped
// during review). Logo top-left, QR top-right (where a physical card's chip would sit), name,
// then a meta row with member #, expiry, and a tier badge. The QR's target verify URL is never
// rendered as visible text — the alt text is the only accessible label — since that URL is a
// bearer credential (see /verify/:token in routes.ts).
function memberCardWidget(card: PortalCard, locale: Locale): string {
  const { data, qrSvg } = card;
  return `
    <div class="member-card">
      <div class="member-card-top">
        <div class="member-card-logo">${logoImg()}</div>
        <div class="member-card-qr" role="img" aria-label="${escapeHtml(t(locale, 'card.qrAlt'))}">${qrSvg}</div>
      </div>
      <div class="member-card-name">${escapeHtml(data.donorName)}</div>
      <div class="member-card-meta">
        <div>${escapeHtml(data.memberNumber)}</div>
        <div><span class="label">${escapeHtml(t(locale, 'card.expiresLabel'))}</span><span class="value">${escapeHtml(data.expiryShort)}</span></div>
        <div class="member-card-tier">${escapeHtml(data.membershipTier)}</div>
      </div>
    </div>
    <form class="member-card-regenerate" action="/${locale}/portal/card/${encodeURIComponent(data.donorId)}/regenerate" method="post">
      <button type="submit">${escapeHtml(t(locale, 'card.regenerate'))}</button>
    </form>
  `;
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

// Volunteer tab: the tab label itself already says "Volunteer history" (portal.volunteerHeading,
// reused rather than duplicated), so the panel content skips a redundant second heading.
function volunteerPanel(history: DonorVolunteerHistory, locale: Locale): string {
  if (history.shifts.length === 0) {
    return emptyStateTab('portal.volunteerEmptyMessage', VOLUNTEER_CTA_URL, 'portal.volunteerButton', locale);
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

// events/eventViews.ts already has near-identical table-rendering for the standalone events
// page, but it imports escapeHtml from this module — importing its helpers back here would be
// circular, so this ~15-line table renderer is duplicated rather than shared.
function eventLabel(record: EventRegistrationRecord): string {
  return record.eventName !== '' ? record.eventName : record.registrationName;
}

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
    return emptyStateTab('events.emptyMessage', EVENTS_CTA_URL, 'events.findEventsButton', locale);
  }
  const upcoming =
    listing.upcoming.length > 0
      ? `<h3>${escapeHtml(t(locale, 'events.upcomingHeading'))}</h3>${eventRegistrationTable(listing.upcoming, locale, false)}`
      : '';
  const past =
    listing.past.length > 0
      ? `<h3>${escapeHtml(t(locale, 'events.pastHeading'))}</h3>${eventRegistrationTable(listing.past, locale, true)}`
      : '';
  return `${upcoming}${past}`;
}

// "Your giving supported …" for the one year routes.ts picked for this donor (selectImpact in
// impact/impact.ts). Statements are operator-set config, not donor input; escaped anyway, like
// every other string the portal renders.
function impactSummary(impact: DonorImpact, locale: Locale): string {
  return `
      <h3>${escapeHtml(t(locale, 'portal.impactHeading', { year: impact.year }))}</h3>
      <p>${escapeHtml(t(locale, 'portal.impactIntro', { year: impact.year }))}</p>
      <ul>
        ${impact.statements.map((statement) => `<li>${escapeHtml(statement)}</li>`).join('')}
      </ul>
  `;
}

function donorSection(
  donor: PortalView['donors'][number],
  locale: Locale,
  card: PortalCard | undefined,
  volunteerHistory: DonorVolunteerHistory | undefined,
  events: EventRegistrationListing | undefined,
  donationHistoryEnabled: boolean,
  impact: DonorImpact | undefined
): string {
  // Each tab appears only when its feature is enabled at all — donations once the history
  // date gate has passed (see donationHistoryEnabled in config.ts), volunteer/events when
  // configured (an undefined donor entry means the whole feature is off or its Monday read
  // failed — see loadPortalData/routes.ts) — independent of whether *this* donor has any
  // entries, which is instead handled inside each panel as an empty-state CTA. With every tab
  // off, renderTabs yields nothing and the section is just the name + membership line.
  const tabs: DonorTab[] = [];
  if (donationHistoryEnabled) {
    tabs.push({ label: t(locale, 'portal.donationsTabLabel'), content: donationsPanel(donor, locale) });
  }
  if (volunteerHistory) {
    tabs.push({ label: t(locale, 'portal.volunteerHeading'), content: volunteerPanel(volunteerHistory, locale), headingWhenAlone: true });
  }
  if (events) {
    tabs.push({ label: t(locale, 'events.tabLabel'), content: eventsPanel(events, locale), headingWhenAlone: true });
  }
  return `
    <section>
      <h2>${escapeHtml(donor.name)}</h2>
      <p>${escapeHtml(t(locale, 'portal.membership', { status: donor.membershipStatus, tier: donor.membershipTier }))}</p>
      ${card ? memberCardWidget(card, locale) : ''}
      ${impact ? impactSummary(impact, locale) : ''}
      ${renderTabs(tabs, `tabs-${donor.id}`)}
    </section>
  `;
}

// Deep links out to Funraise's own donor-account and checkout surfaces — deliberately links,
// not embedded flows, so recurring-gift changes and renewal payments happen entirely on
// Funraise's PCI-scoped pages, never in this Worker (IT Requests item 12893519422). Each link
// renders only when its URL is configured (see funraiseLinks() in config.ts); with neither
// configured the whole section disappears.
function funraiseSection(links: FunraiseLinkUrls, locale: Locale): string {
  const rows = [
    links.manageRecurringUrl !== null
      ? `<li><a href="${escapeHtml(links.manageRecurringUrl)}" rel="noopener noreferrer">${escapeHtml(t(locale, 'portal.manageRecurringLink'))}</a></li>`
      : '',
    links.renewMembershipUrl !== null
      ? `<li><a href="${escapeHtml(links.renewMembershipUrl)}" rel="noopener noreferrer">${escapeHtml(t(locale, 'portal.renewMembershipLink'))}</a></li>`
      : '',
  ].join('');
  if (rows === '') return '';
  return `
    <section>
      <h2>${escapeHtml(t(locale, 'portal.givingLinksHeading'))}</h2>
      <ul>${rows}</ul>
      <p>${escapeHtml(t(locale, 'portal.givingLinksNote'))}</p>
    </section>
  `;
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
// every donor. A category with no links is skipped; no links at all omits the section.
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

// Shown when some of a household's donor items failed to load (issue #31) — the page renders the
// rest rather than failing, but must not silently look complete.
export function someRecordsUnavailableNote(count: number, locale: Locale): string {
  return count > 0 ? `<p role="status">${escapeHtml(t(locale, 'portal.someRecordsUnavailable'))}</p>` : '';
}

function discountRow(discount: DiscountOrganization): string {
  return `<li>${escapeHtml(discount.name)}: ${escapeHtml(discount.discountOffered)}</li>`;
}

export function portalView(
  data: PortalView,
  locale: Locale,
  cards: Record<string, PortalCard>,
  funraise: FunraiseLinkUrls,
  events: Record<string, EventRegistrationListing> | null = null,
  // Keyed by donor id, like cards — a donor without an entry has no impact summary to show.
  impact: Record<string, DonorImpact> = {},
  getInvolved: GetInvolvedLink[] = []
): string {
  return `
    <h1>${escapeHtml(t(locale, 'portal.heading'))}</h1>
    ${someRecordsUnavailableNote(data.unavailableDonorCount ?? 0, locale)}
    ${data.donors.map((donor) => donorSection(donor, locale, cards[donor.id], data.volunteerHistory?.[donor.id], events?.[donor.id], data.donationHistoryEnabled, impact[donor.id])).join('')}
    ${funraiseSection(funraise, locale)}
    ${
      data.discounts === null
        ? ''
        : `<section>
      <h2>${escapeHtml(t(locale, 'portal.discountsHeading'))}</h2>
      <ul>
        ${data.discounts.map(discountRow).join('')}
      </ul>
    </section>`
    }
    ${getInvolvedSection(getInvolved, locale)}
    <p><a href="/${locale}/portal/events">${escapeHtml(t(locale, 'portal.eventsLink'))}</a></p>
    <p><a href="/${locale}/portal/letters">${escapeHtml(t(locale, 'portal.taxDocumentsLink'))}</a></p>
    <p><a href="/${locale}/portal/change-request">${escapeHtml(t(locale, 'portal.changeRequestLink'))}</a></p>
    <p><a href="/${locale}/portal/pledges">${escapeHtml(t(locale, 'portal.pledgesLink'))}</a></p>
    <p><a href="/${locale}/portal/matching-gifts">${escapeHtml(t(locale, 'portal.matchingGiftsLink'))}</a></p>
  `;
}
