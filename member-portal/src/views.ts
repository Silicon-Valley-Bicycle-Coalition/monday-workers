import { SUPPORTED_LOCALES, LOCALE_NATIVE_LABELS, type Locale } from './i18n/locales';
import { t, type TranslationKey } from './i18n/t';
import { LOGO_SVG_ASSET, PORTAL_CSS_ASSET } from './assets/static';

// Brand chrome constants — same values as config/svbc.json's taxLetter.orgLegalName /
// officeAddress / mailingAddress / ein, duplicated here (rather than threaded through every
// page() call site) because this is footer branding copy, not operational config. Keep in sync
// if the org's legal name, addresses, EIN, or these URLs change.
const ORG_NAME = 'Silicon Valley Bicycle Coalition';
const ORG_ADDRESS = '95 S Market St, Suite 648, San José, CA 95113';
const ORG_MAILING_ADDRESS = 'PO Box 1927, San José, CA 95109';
const ORG_EIN = '77-0338658';
const ORG_WEBSITE_URL = 'https://bikesiliconvalley.org';
export const ORG_DONATE_URL = 'https://bikesiliconvalley.org/ways-to-give';
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
// `decorative`: alt="" where the organization is already named nearby (the member card sits under
// the site header's logo), so a screen reader doesn't read the name twice.
export function logoImg(className?: string, decorative = false): string {
  const cls = className ? ` class="${className}"` : '';
  const alt = decorative ? '' : 'Silicon Valley Bicycle Coalition';
  return `<img${cls} src="${LOGO_SVG_ASSET.path}" width="235" height="90" alt="${alt}" />`;
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
// browser's actual current location.pathname + location.search right before submitting, so
// switching language returns the visitor to wherever they were (the sign-in page's ?next=
// included) without this needing to be threaded through every page() call site. No visible submit button: a no-JS visitor can't change the value via this
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
          <select name="code" onchange="this.form.to.value = location.pathname + location.search; this.form.submit()">${options}</select>
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
// languagePicker: false drops the footer language <select> — for pages whose query string must
// not reach the /lang redirect URL. GET /auth/callback is the one: a legacy link carries its token
// in ?token=, which the picker's `to` (pathname + search) would copy into the /lang URL.
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
    <a class="skip-link" href="#main">${escapeHtml(t(locale, 'a11y.skipToContent'))}</a>
    ${siteHeader(locale, options.authenticated ?? false)}
    <main id="main" tabindex="-1">${body}</main>
    ${siteFooter(locale, options.languagePicker ?? true)}
  </body>
</html>`;
}

// Shared by the authenticated sub-pages (pledges, matching gifts; older views predate it and
// still inline the same markup — fold them in when next touched).
export function backToPortalLink(locale: Locale): string {
  return `<p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>`;
}

// `next` (return-to after sign-in) arrives already validated by routes.ts's portalReturnPath.
export function loginFormView(locale: Locale, next: string | null = null): string {
  const nextField = next === null ? '' : `\n      <input type="hidden" name="next" value="${escapeHtml(next)}" />`;
  return `
    <h1>${escapeHtml(t(locale, 'login.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'login.prompt'))}</p>
    <form action="/" method="post">
      <input type="email" name="email" required />${nextField}
      <button type="submit">${escapeHtml(t(locale, 'login.submit'))}</button>
    </form>
  `;
}

// The code form posts to /auth/code; the request cookie it relies on was set by POST /. `next`
// arrives already validated by routes.ts's portalReturnPath. codeError re-renders the page after a
// refused code.
export function checkEmailView(locale: Locale, next: string | null = null, codeError = false): string {
  const nextField = next === null ? '' : `\n      <input type="hidden" name="next" value="${escapeHtml(next)}" />`;
  const error = codeError ? `\n    <p role="alert">${escapeHtml(t(locale, 'checkEmail.codeError'))}</p>` : '';
  return `
    <h1>${escapeHtml(t(locale, 'checkEmail.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'checkEmail.body'))}</p>${error}
    <form action="/auth/code" method="post">
      <label for="sign-in-code">${escapeHtml(t(locale, 'checkEmail.codeLabel'))}</label>
      <input id="sign-in-code" type="text" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required />${nextField}
      <button type="submit">${escapeHtml(t(locale, 'checkEmail.codeSubmit'))}</button>
    </form>
  `;
}

// GET /auth/callback's body (issue GL#31): a plain button that POSTs the magic-link token back,
// because mail scanners prefetch links and a GET that consumed the single-use token burned it
// before the donor clicked. Deliberately no script, no autofocus, no auto-submit — scanners that
// execute JS must not be able to complete the login. `lang` is only emitted when it's a
// supported locale (the caller validates), so nothing attacker-shaped is reflected besides the
// escaped token.
// Issue GL#61: new links carry the token in the URL fragment, which the browser never sends, so
// this copies it into the confirm form and drops it from the address bar and history. It only
// fills the form, never submits it: mail scanners that run a page's JS would otherwise burn the
// single-use token (issue GL#31). With no token in the fragment it swaps in the invalid-link copy.
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
// legacy ?token= link, sent before issue GL#61, which renders as before with no script.
export function confirmLoginView(token: string | null, lang: Locale | null, locale: Locale, next: string | null = null): string {
  const langField = lang === null ? '' : `\n      <input type="hidden" name="lang" value="${escapeHtml(lang)}" />`;
  const nextField = next === null ? '' : `\n      <input type="hidden" name="next" value="${escapeHtml(next)}" />`;
  const form = `
    <h1>${escapeHtml(t(locale, 'confirmLogin.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'confirmLogin.body'))}</p>
    <form action="/auth/callback" method="post">
      <input type="hidden" name="token" value="${escapeHtml(token ?? '')}"${token === null ? ' id="confirm-token"' : ''} />${langField}${nextField}
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
// a 503. A signed-in donor gets a way back to the home page, which still works.
export function unavailableView(locale: Locale, authenticated: boolean): string {
  const back = authenticated ? `<p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>` : '';
  return `
    <h1>${escapeHtml(t(locale, 'unavailable.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'unavailable.body'))}</p>
    ${back}
  `;
}

// Shown when some of a household's donor items failed to load (issue GL#31) — the page renders the
// rest rather than failing, but must not silently look complete.
export function someRecordsUnavailableNote(count: number, locale: Locale): string {
  return count > 0 ? `<p role="status">${escapeHtml(t(locale, 'portal.someRecordsUnavailable'))}</p>` : '';
}
