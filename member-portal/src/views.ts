import type {
  DiscountOrganization,
  DonorImpact,
  DonorVolunteerHistory,
  EventRegistrationRecord,
  FunraiseLinkUrls,
  PortalView,
} from './types';
import { SUPPORTED_LOCALES, LOCALE_NATIVE_LABELS, type Locale } from './i18n/locales';
import { t, type TranslationKey } from './i18n/t';
import { SVBC_LOGO_SVG } from './assets/logo';
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

// Brand tokens (SVBC black/gold/white) plus the page chrome shared by every route. Scoped mostly
// by element selector rather than per-view classes, so styling the whole portal costs this one
// block instead of touching every view file. The generic button[type=submit] rule is scoped to
// `main` so it doesn't fight with .site-header's own outline-style logout button.
const STYLE = `
  :root {
    --svbc-black: #221E1F;
    --svbc-gold: #FEC10C;
    --svbc-white: #FFFFFF;
    /* Semantic tokens that flip under prefers-color-scheme below. The brand tokens above stay
       fixed in both themes — header/footer bars, the member card, and table headers are
       deliberately always-dark brand chrome, not page background. */
    --bg: var(--svbc-white);
    --text: var(--svbc-black);
    --surface: var(--svbc-white);
    --border: #ccc;
    --table-border: #eee;
    --row-stripe: #fafafa;
    --tab-bg: #f0f0f0;
    --tab-border: #ddd;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1b1b;
      --text: #ececec;
      --surface: #2a2828;
      --border: #4d4a4a;
      --table-border: #3a3838;
      --row-stripe: #242222;
      --tab-bg: #2a2828;
      --tab-border: #4d4a4a;
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  /* Classic flexbox sticky footer: body is a min-viewport-height column, main grows to fill
     whatever space the (short) page content doesn't use, so the footer sits at the bottom of
     the viewport instead of floating right under a short page — but still gets pushed down and
     scrolls normally once real content is taller than the viewport. */
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--text);
    background: var(--bg);
  }
  a { color: var(--text); }
  /* The header/footer bars are full-bleed edge-to-edge, like bikesiliconvalley.org's own nav —
     matching its visual weight matters more here than lining up with <main>'s narrower 720px
     reading column underneath, which stays capped for form/table readability. Same fixed side
     padding on both bars, so they at least align with *each other*. */
  .site-header {
    background: rgb(48, 48, 48);
  }
  .site-header-inner {
    padding: 14px 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .site-header-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  /* width:auto below is load-bearing, not a default-value no-op: an <svg>'s width/height
     presentation attributes act as its UA-stylesheet width/height, so without an explicit
     author width:auto here, the browser treats width as independently specified (260px, from
     the attribute) rather than "unset", and never derives it from the height override plus the
     intrinsic ratio — the logo renders at a fixed 260px wide at every height, non-proportional
     at any height that isn't ~101px (e.g. the mobile override below). */
  .site-header .site-logo {
    height: 100px;
    width: auto;
    display: block;
  }
  .site-header-logo-link {
    display: block;
    line-height: 0;
  }
  .site-header-donate {
    height: 44px;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    white-space: nowrap;
    background: var(--svbc-gold);
    color: var(--svbc-black);
    border: 1px solid var(--svbc-gold);
    padding: 0 26px;
    font-size: 15px;
    font-weight: bold;
    line-height: 1;
    border-radius: 22px;
    text-decoration: none;
  }
  main {
    max-width: 720px;
    width: 100%;
    margin: 0 auto;
    padding: 20px;
    flex: 1 0 auto;
    display: flex;
    flex-direction: column;
    /* Vertically centers the page's content as a group within the header/footer gap (align-items
       stays the stretch default, so each child still spans main's full centered width exactly as
       before — only the vertical position of the stack changes). "safe" falls back to top-aligned
       start position once content is taller than the available space, instead of centering an
       overflow and clipping the top off-screen. */
    justify-content: safe center;
  }
  button {
    font-family: inherit;
    font-size: 14px;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--text);
    background: var(--surface);
    color: var(--text);
  }
  main button[type='submit'] {
    background: var(--svbc-gold);
    border-color: var(--svbc-gold);
    font-weight: bold;
  }
  .site-header .logout-form button {
    height: 32px;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
    white-space: nowrap;
    background: transparent;
    color: var(--svbc-gold);
    border-color: var(--svbc-gold);
    padding: 0 14px;
    font-size: 13px;
    line-height: 1;
  }
  input[type='email'], input[type='text'], select {
    font-size: 14px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface);
    color: var(--text);
  }
  /* Buttons with real padding/borders (vs. the tiny default inline button) need breathing room
     when a wrapped line lands right above the next list item — e.g. the portal's per-language
     "make this my language" buttons, one per <li>. */
  li {
    margin: 4px 0;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
  }
  th {
    background: var(--svbc-black);
    color: var(--svbc-gold);
    text-align: left;
    padding: 6px 10px;
  }
  td {
    padding: 6px 10px;
    border-bottom: 1px solid var(--table-border);
  }
  tbody tr:nth-child(even) td { background: var(--row-stripe); }
  .col-amount { text-align: right; }
  tfoot td {
    font-weight: bold;
    border-top: 2px solid var(--text);
    border-bottom: none;
  }

  /* CSS-only tabs (no JS anywhere in this portal): real radio inputs + labels, shown/hidden via
     :checked and positional :nth-of-type sibling selectors — so the same static rule set works
     for any subset of the three possible tabs (donations always; volunteering and event
     registrations only when that feature is enabled), regardless of which ones a given donor
     actually has. Inputs and labels share the same order value (flexbox then falls back to DOM
     order within a tie, i.e. input-then-its-own-label), with panels after — no position:absolute
     on the inputs, since taking three same-sized boxes out of flow collapses them on top of each
     other instead of next to their own label, breaking anything that targets the input's own hit
     area (assistive tech, automated clicks) even though clicking the visible label still "works"
     by accident. */
  .tabs { display: flex; flex-wrap: wrap; margin: 12px 0; }
  .tab-input { order: 1; opacity: 0; width: 1px; height: 1px; overflow: hidden; }
  .tab-label {
    order: 1;
    padding: 8px 16px;
    margin: 0 4px 0 0;
    cursor: pointer;
    background: var(--tab-bg);
    border: 1px solid var(--tab-border);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    font-weight: bold;
    font-size: 14px;
  }
  .tab-input:checked + .tab-label {
    background: var(--svbc-black);
    color: var(--svbc-gold);
    border-color: var(--svbc-black);
  }
  .tab-input:focus-visible + .tab-label {
    outline: 2px solid var(--svbc-gold);
    outline-offset: 2px;
  }
  .tab-panel {
    order: 2;
    display: none;
    width: 100%;
    padding-top: 14px;
    border-top: 2px solid var(--text);
  }
  .tab-input:nth-of-type(1):checked ~ .tab-panel:nth-of-type(1),
  .tab-input:nth-of-type(2):checked ~ .tab-panel:nth-of-type(2),
  .tab-input:nth-of-type(3):checked ~ .tab-panel:nth-of-type(3) {
    display: block;
  }
  .tab-empty { padding: 8px 0; }
  .cta-button {
    display: inline-flex;
    align-items: center;
    height: 38px;
    background: var(--svbc-gold);
    color: var(--svbc-black);
    border: 1px solid var(--svbc-gold);
    padding: 0 20px;
    font-size: 14px;
    font-weight: bold;
    border-radius: 19px;
    text-decoration: none;
    margin-top: 4px;
  }

  /* Wallet-style membership card, embedded per-donor on the dashboard (not a separate page —
     see routes.ts's GET /:locale/portal). Fixed max-width with aspect-ratio (not a fixed height)
     so it scales down cleanly on narrow viewports instead of overflowing. */
  .member-card {
    position: relative;
    width: 100%;
    max-width: 340px;
    aspect-ratio: 340 / 214;
    margin: 12px 0;
    border-radius: 16px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.25), 0 2px 6px rgba(0,0,0,0.15);
    overflow: hidden;
    color: var(--svbc-white);
    background: linear-gradient(135deg, #2b2628 0%, var(--svbc-black) 55%, #171415 100%);
    padding: 18px 22px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    box-sizing: border-box;
  }
  .member-card::after {
    content: '';
    position: absolute; top: -60%; left: -20%; width: 140%; height: 140%;
    background: radial-gradient(circle at 30% 20%, rgba(254,193,12,0.10), transparent 55%);
    pointer-events: none;
  }
  .member-card-top { display: flex; align-items: flex-start; justify-content: space-between; }
  /* height:53px (not the header's 100px) keeps the badge's rendered footprint the same as
     before the logo.ts crop fix (SVBC_LOGO_SVG's viewBox is shared across both contexts, so a
     given CSS height now renders roughly 2x larger than it used to) — the card is a fixed
     340px-wide wallet layout with the QR code sharing this row, and doesn't have room to spare. */
  .member-card-logo svg { display: block; height: 53px; width: auto; }
  .member-card-qr {
    flex-shrink: 0;
    background: #171415;
    padding: 5px;
    border-radius: 6px;
    box-shadow: inset 0 0 0 1px rgba(254,193,12,0.35);
  }
  .member-card-qr svg { display: block; width: 77px; height: 77px; }
  .member-card-name { font-size: 19px; font-weight: 700; letter-spacing: 0.02em; }
  .member-card-meta {
    display: flex; justify-content: space-between; align-items: flex-end;
    font-size: 11px; color: #cfcfcf; gap: 10px;
  }
  .member-card-meta .label { text-transform: uppercase; letter-spacing: 0.06em; }
  .member-card-meta .value { display: block; color: var(--svbc-white); font-size: 13px; margin-top: 2px; }
  .member-card-tier {
    display: inline-block; background: var(--svbc-gold); color: var(--svbc-black); font-weight: 700;
    font-size: 11px; letter-spacing: 0.04em; padding: 3px 10px; border-radius: 20px;
    text-transform: uppercase; white-space: nowrap;
  }
  .member-card-regenerate { margin: 6px 0 0; }
  /* Selects button[type=submit], not just button, to out-specificity the main button[type=submit]
     gold-fill rule above — same fix as .site-header .logout-form button. */
  .member-card-regenerate button[type='submit'] {
    background: none; border: none; color: #888; font-size: 12px; text-decoration: underline;
    cursor: pointer; padding: 4px 0; font-weight: normal;
  }

  .site-footer {
    background: rgb(48, 48, 48);
    color: #cfcfcf;
    margin-top: 40px;
    font-size: 13px;
    flex-shrink: 0;
  }
  .site-footer-inner {
    padding: 20px 40px;
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 20px;
  }
  .site-footer p { margin: 0 0 4px; }
  .site-footer a { color: var(--svbc-gold); }
  .site-footer-lang {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .site-footer-lang select {
    font-size: 13px;
    padding: 4px 6px;
  }

  @media (max-width: 480px) {
    .site-header-inner, .site-footer-inner { padding-left: 20px; padding-right: 20px; }
    /* flex-wrap as a defensive fallback (logo + logout + donate wrap to a second row rather than
       overflowing off-screen) below the width this specific logo/button sizing was tuned to fit
       on one line down to a ~375px viewport. */
    .site-header-inner { flex-wrap: wrap; row-gap: 10px; }
    .site-header .site-logo { height: 56px; }
    .site-header-donate { height: 36px; padding: 0 16px; font-size: 13px; border-radius: 18px; }
  }
  @media print {
    .site-header, .site-footer { display: none; }
    /* A printed/PDF'd dashboard should show every tab's content, not just whichever was active
       on screen. */
    .tab-panel { display: block !important; }
    .tab-label { display: none; }
  }
`;

function siteHeader(locale: Locale, authenticated: boolean): string {
  const logoutForm = authenticated
    ? `<form class="logout-form" action="/logout" method="post"><button type="submit">${escapeHtml(t(locale, 'portal.logout'))}</button></form>`
    : '';
  return `<header class="site-header">
    <div class="site-header-inner">
      <a class="site-header-logo-link" href="${ORG_WEBSITE_URL}" target="_blank" rel="noopener noreferrer">${SVBC_LOGO_SVG}</a>
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
    <style>${STYLE}</style>
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
export function confirmLoginView(token: string, lang: Locale | null, locale: Locale): string {
  const langField = lang === null ? '' : `\n      <input type="hidden" name="lang" value="${escapeHtml(lang)}" />`;
  return `
    <h1>${escapeHtml(t(locale, 'confirmLogin.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'confirmLogin.body'))}</p>
    <form action="/auth/callback" method="post">
      <input type="hidden" name="token" value="${escapeHtml(token)}" />${langField}
      <button type="submit">${escapeHtml(t(locale, 'confirmLogin.submit'))}</button>
    </form>
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
      <td>${escapeHtml(donation.description)}</td>
    </tr>
  `;
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
        <div class="member-card-logo">${SVBC_LOGO_SVG}</div>
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
  impact: Record<string, DonorImpact> = {}
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
    <p><a href="/${locale}/portal/events">${escapeHtml(t(locale, 'portal.eventsLink'))}</a></p>
    <p><a href="/${locale}/portal/letters">${escapeHtml(t(locale, 'portal.taxDocumentsLink'))}</a></p>
    <p><a href="/${locale}/portal/change-request">${escapeHtml(t(locale, 'portal.changeRequestLink'))}</a></p>
    <p><a href="/${locale}/portal/pledges">${escapeHtml(t(locale, 'portal.pledgesLink'))}</a></p>
    <p><a href="/${locale}/portal/matching-gifts">${escapeHtml(t(locale, 'portal.matchingGiftsLink'))}</a></p>
  `;
}
