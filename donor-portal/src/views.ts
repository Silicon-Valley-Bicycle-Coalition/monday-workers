import type { PortalView } from './types';
import { SUPPORTED_LOCALES, LOCALE_LABELS, type Locale } from './i18n/locales';
import { t, type TranslationKey } from './i18n/t';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Wraps a view's HTML fragment in a minimal document so the browser has a real <title> and
// viewport meta — without it, browsers fall back to printing the bare URL in default print
// headers/footers, which is how the tax letter page used to print (see letterViews.letterView).
export function page(title: string, body: string, locale: Locale): string {
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

// Shared by every pre-identity view (login, check-email, error, verify): a plain link per
// supported locale, each pointing at /lang/:code?to=<current path> so picking one applies
// immediately and returns the visitor to where they were.
export function languagePicker(currentPath: string, locale: Locale): string {
  const options = SUPPORTED_LOCALES.map(
    (code) => `<a href="/lang/${code}?to=${encodeURIComponent(currentPath)}">${escapeHtml(LOCALE_LABELS[code])}</a>`
  ).join(' · ');
  return `<nav aria-label="${escapeHtml(t(locale, 'languagePicker.label'))}">${options}</nav>`;
}

// Shared by the authenticated sub-pages (pledges, matching gifts; older views predate it and
// still inline the same markup — fold them in when next touched).
export function backToPortalLink(locale: Locale): string {
  return `<p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>`;
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
      <td>${escapeHtml(donation.date)}</td>
      <td>${escapeHtml(donation.amount)}</td>
      <td>${escapeHtml(donation.description)}</td>
    </tr>
  `;
}

function donorSection(donor: PortalView['donors'][number], locale: Locale): string {
  return `
    <section>
      <h2>${escapeHtml(donor.name)}</h2>
      <p>${escapeHtml(t(locale, 'portal.membership', { status: donor.membershipStatus, tier: donor.membershipTier }))}</p>
      <p>${escapeHtml(t(locale, 'portal.totalDonated', { total: donor.totalDonated }))}</p>
      <p><a href="/${locale}/portal/card/${encodeURIComponent(donor.id)}">${escapeHtml(t(locale, 'portal.membershipCardLink'))}</a></p>
      <table>
        <thead>
          <tr><th>${escapeHtml(t(locale, 'portal.tableDate'))}</th><th>${escapeHtml(t(locale, 'portal.tableAmount'))}</th><th>${escapeHtml(t(locale, 'portal.tableDescription'))}</th></tr>
        </thead>
        <tbody>
          ${donor.donations.map((d) => donationRow(d, locale)).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function discountRow(discount: PortalView['discounts'][number]): string {
  return `<li>${escapeHtml(discount.name)}: ${escapeHtml(discount.discountOffered)}</li>`;
}

// Distinct from languagePicker() (Task 4): this one is for the *authenticated* portal, where
// picking a language does two things — switches this visit's browsing locale immediately
// (via /lang/:code, same as the pre-identity picker) and offers to make it the donor's
// on-file preference via a change request (staff-reviewed, same path as an address/phone edit —
// see submitChangeRequest.ts). Each option is its own small form rather than one <select> with
// JS, keeping this view framework-free and working with JS disabled.
function portalLanguageSwitcher(locale: Locale, donorItemId: string): string {
  const currentPath = `/${locale}/portal`;
  const rows = SUPPORTED_LOCALES.filter((code) => code !== locale)
    .map((code) => {
      const label = LOCALE_LABELS[code];
      return `
        <li>
          <a href="/lang/${code}?to=${encodeURIComponent(currentPath)}">${escapeHtml(label)}</a>
          <form action="/${locale}/portal/change-request" method="post" style="display:inline">
            <input type="hidden" name="donorItemId" value="${escapeHtml(donorItemId)}" />
            <input type="hidden" name="field" value="language" />
            <input type="hidden" name="newValue" value="${escapeHtml(label)}" />
            <button type="submit">${escapeHtml(t(locale, 'changeRequest.submit'))}</button>
          </form>
        </li>
      `;
    })
    .join('');
  return `<section><h2>${escapeHtml(t(locale, 'languagePicker.label'))}</h2><ul>${rows}</ul></section>`;
}

export function portalView(data: PortalView, locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'portal.heading'))}</h1>
    ${data.donors.length > 0 ? portalLanguageSwitcher(locale, data.donors[0]!.id) : ''}
    ${data.donors.map((donor) => donorSection(donor, locale)).join('')}
    <section>
      <h2>${escapeHtml(t(locale, 'portal.discountsHeading'))}</h2>
      <ul>
        ${data.discounts.map(discountRow).join('')}
      </ul>
    </section>
    <p><a href="/${locale}/portal/letters">${escapeHtml(t(locale, 'portal.taxDocumentsLink'))}</a></p>
    <p><a href="/${locale}/portal/change-request">${escapeHtml(t(locale, 'portal.changeRequestLink'))}</a></p>
    <p><a href="/${locale}/portal/pledges">${escapeHtml(t(locale, 'portal.pledgesLink'))}</a></p>
    <p><a href="/${locale}/portal/matching-gifts">${escapeHtml(t(locale, 'portal.matchingGiftsLink'))}</a></p>
    <form action="/logout" method="post"><button type="submit">${escapeHtml(t(locale, 'portal.logout'))}</button></form>
  `;
}
