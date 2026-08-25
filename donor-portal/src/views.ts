import type { PortalView } from './types';
import { SUPPORTED_LOCALES, LOCALE_LABELS, type Locale } from './i18n/locales';
import { t, type TranslationKey } from './i18n/t';
import { SVBC_LOGO_SVG } from './assets/logo';
import { formatUsdText } from './money';
import { formatShortDate } from './dates';
import type { PortalCard } from './card/loadCardData';

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
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--svbc-black);
    background: var(--svbc-white);
  }
  a { color: var(--svbc-black); }
  .site-header {
    background: var(--svbc-black);
    padding: 14px 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  /* The wordmark's speech-bubble tail extends into the crop's bottom margin, so its geometric
     bounding box centers lower than the visible badge — top:16px (~25% of the 64px height)
     nudges it down to optically align with the button. See src/assets/logo.ts. */
  .site-header .site-logo {
    height: 64px;
    position: relative;
    top: 16px;
    display: block;
  }
  main {
    max-width: 720px;
    margin: 0 auto;
    padding: 20px;
  }
  button {
    font-family: inherit;
    font-size: 14px;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
    border: 1px solid var(--svbc-black);
    background: var(--svbc-white);
    color: var(--svbc-black);
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
    border: 1px solid #ccc;
    border-radius: 4px;
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
    border-bottom: 1px solid #eee;
  }
  tbody tr:nth-child(even) td { background: #fafafa; }
  .col-amount { text-align: right; }
  tfoot td {
    font-weight: bold;
    border-top: 2px solid var(--svbc-black);
    border-bottom: none;
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
  .member-card-logo svg { display: block; height: 96px; width: auto; }
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

  @media (max-width: 480px) {
    .site-header .site-logo { height: 48px; top: 12px; }
  }
  @media print {
    .site-header { display: none; }
  }
`;

function siteHeader(locale: Locale, authenticated: boolean): string {
  const logoutForm = authenticated
    ? `<form class="logout-form" action="/logout" method="post"><button type="submit">${escapeHtml(t(locale, 'portal.logout'))}</button></form>`
    : '';
  return `<header class="site-header">${SVBC_LOGO_SVG}${logoutForm}</header>`;
}

// Wraps a view's HTML fragment in a minimal document so the browser has a real <title> and
// viewport meta — without it, browsers fall back to printing the bare URL in default print
// headers/footers, which is how the tax letter page used to print (see letterViews.letterView).
// `authenticated` shows the shared header's logout button — every route inside the session-gated
// /:locale/portal* tree passes true; the pre-identity and public /verify routes leave it false.
export function page(title: string, body: string, locale: Locale, options: { authenticated?: boolean } = {}): string {
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
  </body>
</html>`;
}

// Shared by every pre-identity view (login, check-email, error, verify): a <select> of every
// supported locale, submitting to GET /lang?code=&to=<current path> so picking one and hitting
// the button applies immediately and returns the visitor to where they were.
export function languagePicker(currentPath: string, locale: Locale): string {
  const options = SUPPORTED_LOCALES.map(
    (code) => `<option value="${code}"${code === locale ? ' selected' : ''}>${escapeHtml(LOCALE_LABELS[code])}</option>`
  ).join('');
  return `
    <form action="/lang" method="get" aria-label="${escapeHtml(t(locale, 'languagePicker.label'))}">
      <input type="hidden" name="to" value="${escapeHtml(currentPath)}" />
      <select name="code">${options}</select>
      <button type="submit">${escapeHtml(t(locale, 'languagePicker.switch'))}</button>
    </form>
  `;
}

export function loginFormView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'site.title'))}</h1>
    ${languagePicker('/login', locale)}
    <p>${escapeHtml(t(locale, 'login.prompt'))}</p>
    <form action="/login" method="post">
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

export function errorView(messageKey: TranslationKey, locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'error.heading'))}</h1>
    <p>${escapeHtml(t(locale, messageKey))}</p>
    <p><a href="/login">${escapeHtml(t(locale, 'error.requestNewLink'))}</a></p>
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

function donorSection(donor: PortalView['donors'][number], locale: Locale, card: PortalCard | undefined): string {
  return `
    <section>
      <h2>${escapeHtml(donor.name)}</h2>
      <p>${escapeHtml(t(locale, 'portal.membership', { status: donor.membershipStatus, tier: donor.membershipTier }))}</p>
      ${card ? memberCardWidget(card, locale) : ''}
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
    </section>
  `;
}

function discountRow(discount: PortalView['discounts'][number]): string {
  return `<li>${escapeHtml(discount.name)}: ${escapeHtml(discount.discountOffered)}</li>`;
}

// Distinct from languagePicker() (Task 4): this one is for the *authenticated* portal, but is
// otherwise the same <select>-to-/lang pattern — it only switches this visit's browsing locale.
// It used to also offer a per-language "make this my on-file preference" change-request button,
// but that was redundant with the general "Request a change" form's own Language field (see
// changeRequestFormView) and didn't collapse cleanly into a single <select> (switching languages
// and requesting a permanent preference change are different actions with different targets/
// methods) — dropped in favor of directing donors to that existing form instead.
function portalLanguageSwitcher(locale: Locale): string {
  const currentPath = `/${locale}/portal`;
  const options = SUPPORTED_LOCALES.map(
    (code) => `<option value="${code}"${code === locale ? ' selected' : ''}>${escapeHtml(LOCALE_LABELS[code])}</option>`
  ).join('');
  return `
    <section>
      <h2>${escapeHtml(t(locale, 'languagePicker.label'))}</h2>
      <form action="/lang" method="get">
        <input type="hidden" name="to" value="${escapeHtml(currentPath)}" />
        <select name="code">${options}</select>
        <button type="submit">${escapeHtml(t(locale, 'languagePicker.switch'))}</button>
      </form>
    </section>
  `;
}

export function portalView(data: PortalView, locale: Locale, cards: Record<string, PortalCard>): string {
  return `
    <h1>${escapeHtml(t(locale, 'portal.heading'))}</h1>
    ${portalLanguageSwitcher(locale)}
    ${data.donors.map((donor) => donorSection(donor, locale, cards[donor.id])).join('')}
    <section>
      <h2>${escapeHtml(t(locale, 'portal.discountsHeading'))}</h2>
      <ul>
        ${data.discounts.map(discountRow).join('')}
      </ul>
    </section>
    <p><a href="/${locale}/portal/letters">${escapeHtml(t(locale, 'portal.taxDocumentsLink'))}</a></p>
    <p><a href="/${locale}/portal/change-request">${escapeHtml(t(locale, 'portal.changeRequestLink'))}</a></p>
  `;
}
