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

function donationRow(donation: PortalView['donors'][number]['donations'][number]): string {
  return `
    <tr>
      <td>${escapeHtml(donation.date)}</td>
      <td>${escapeHtml(donation.amount)}</td>
      <td>${escapeHtml(donation.description)}</td>
    </tr>
  `;
}

function donorSection(donor: PortalView['donors'][number]): string {
  return `
    <section>
      <h2>${escapeHtml(donor.name)}</h2>
      <p>Membership: ${escapeHtml(donor.membershipStatus)} (${escapeHtml(donor.membershipTier)})</p>
      <p>Total donated: ${escapeHtml(donor.totalDonated)}</p>
      <p><a href="/portal/card/${encodeURIComponent(donor.id)}">Membership card</a></p>
      <table>
        <thead>
          <tr><th>Date</th><th>Amount</th><th>Description</th></tr>
        </thead>
        <tbody>
          ${donor.donations.map(donationRow).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function discountRow(discount: PortalView['discounts'][number]): string {
  return `<li>${escapeHtml(discount.name)}: ${escapeHtml(discount.discountOffered)}</li>`;
}

export function portalView(data: PortalView): string {
  return `
    <h1>Your donor portal</h1>
    ${data.donors.map(donorSection).join('')}
    <section>
      <h2>Bike shop discounts</h2>
      <ul>
        ${data.discounts.map(discountRow).join('')}
      </ul>
    </section>
    <p><a href="/portal/letters">Tax documents</a></p>
    <p><a href="/portal/change-request">Request a change to your details</a></p>
    <form action="/logout" method="post"><button type="submit">Log out</button></form>
  `;
}
