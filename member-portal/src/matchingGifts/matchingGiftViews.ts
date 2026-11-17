import { backToPortalLink, escapeHtml } from '../views';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

// Serializes a trusted config string into a JS literal inside an inline <script>. JSON.stringify
// handles quotes/backslashes; the extra < escape stops a "</script>" substring from
// terminating the script block early. The key is operator-set config, not user input — this is
// defense-in-depth, same spirit as passing trusted donorItemIds as GraphQL variables.
function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// Embed matches DTD's "Standard Javascript Embed using Shadow DOM Encapsulation" snippet as
// captured from SVBC's DTD account on 2026-11-03 (ddplugin.js + a #dd-shadow-container div with
// DTD's attribution links + doublethedonation.plugin.v2.load_plugin(..., {isolated: true})). The
// key comes from config instead of being pasted in.
//
// No Subresource Integrity hash on ddplugin.js, deliberately: DTD serves a mutable, unversioned
// URL they update at will, so any pinned hash silently breaks the widget on their next release.
// The compensating control is isolation (issue #102): the widget never runs on the portal's
// origin. It lives in its own document (matchingGiftsSearchDocument, served by
// GET /:locale/portal/matching-gifts/search) whose CSP carries `sandbox` without
// allow-same-origin, so the browser gives it an opaque origin. A compromised ddplugin.js there
// can't read a same-origin popup of /portal (the popup is cross-origin to it), can't submit a
// form the CSRF check accepts (its Origin is "null"), and can't read the session cookie.
function searchWidget(publicApiKey: string): string {
  return `
    <script src="https://doublethedonation.com/api/js/ddplugin.js"></script>
    <div id="dd-shadow-container">
      <a href="https://doublethedonation.com/matching-grant-resources/matching-gift-basics/">Matching Gift</a> and
      <a href="https://doublethedonation.com/matching-grant-resources/volunteer-grant-basics/">Volunteer Grant</a> information provided by
      <br>
      <a href="https://doublethedonation.com">
        <img alt="Powered by Double the Donation" src="https://doublethedonation.com/api/img/powered-by.png" />
      </a>
    </div>
    <script>
      var shadow_container = document.getElementById("dd-shadow-container");
      doublethedonation.plugin.v2.load_plugin(shadow_container, ${jsString(publicApiKey)}, { isolated: true });
    </script>
  `;
}

// The sandbox flags, shared by the iframe attribute and the search document's CSP `sandbox`
// directive (the browser applies the intersection, so they must agree). Never add
// allow-same-origin: that would put the widget back on the portal's origin. allow-popups and
// allow-popups-to-escape-sandbox let DTD's company links and submission guides open normally in
// a new tab; no allow-forms, allow-top-navigation or allow-modals.
export const SEARCH_SANDBOX_FLAGS = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

// The search document's CSP. `sandbox` is the load-bearing directive: it applies even if the URL
// is opened top-level rather than framed. The rest limits what the widget can load and where it
// can send data, and frame-ancestors 'self' lets only the portal frame it.
export const SEARCH_DOCUMENT_CSP =
  `sandbox ${SEARCH_SANDBOX_FLAGS}; default-src 'none'; ` +
  "script-src 'unsafe-inline' https://doublethedonation.com; " +
  "style-src 'unsafe-inline' https://doublethedonation.com; " +
  'img-src https://doublethedonation.com data:; font-src https://doublethedonation.com; ' +
  "connect-src https://doublethedonation.com; frame-ancestors 'self'; base-uri 'none'; form-action 'none'";

// Reports the document's height to the framing portal page so the iframe can grow with the
// widget's results instead of scrolling inside a fixed box. Posts only a number; the receiving
// listener (matchingGiftsView) checks the message came from its own iframe and bounds the value.
// targetOrigin is '*' because an opaque-origin document has no meaningful origin to name, and
// the payload is not sensitive.
const RESIZE_REPORTER = `
    <script>
      (function () {
        function report() { parent.postMessage({ ddSearchHeight: document.documentElement.scrollHeight }, "*"); }
        if (typeof ResizeObserver === "function") new ResizeObserver(report).observe(document.body);
        window.addEventListener("load", report);
      })();
    </script>
`;

// The standalone document the portal frames. Renders nothing but the widget: no portal chrome,
// no donor data, no links back into the portal.
export function matchingGiftsSearchDocument(publicApiKey: string, locale: Locale): string {
  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(t(locale, 'matchingGifts.searchFrameTitle'))}</title>
    <style>body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }</style>
  </head>
  <body>
    ${searchWidget(publicApiKey)}
    ${RESIZE_REPORTER}
  </body>
</html>`;
}

// The portal-side frame. Starts at a height that fits the empty search box and grows on the
// search document's height reports.
function searchFrame(locale: Locale): string {
  return `
    <iframe id="dd-search-frame" src="/${locale}/portal/matching-gifts/search" sandbox="${SEARCH_SANDBOX_FLAGS}"
      title="${escapeHtml(t(locale, 'matchingGifts.searchFrameTitle'))}" loading="lazy"
      style="width: 100%; height: 480px; border: 0;"></iframe>
    <script>
      (function () {
        var frame = document.getElementById("dd-search-frame");
        window.addEventListener("message", function (event) {
          if (event.source !== frame.contentWindow) return;
          var height = event.data && event.data.ddSearchHeight;
          if (typeof height === "number" && height > 0 && height < 10000) frame.style.height = Math.ceil(height) + "px";
        });
      })();
    </script>
  `;
}

export interface MatchingGiftsViewOptions {
  // Double the Donation public plugin key; null renders the page without the embedded search.
  publicApiKey: string | null;
  // SVBC's EIN from taxLetter config; null while that's still REPLACE_AFTER_SIGNOFF.
  ein: string | null;
  // The portal's employer form (change-request page, Employer preselected); null or absent while
  // employerAnswerEnabled is off.
  employerFormUrl?: string | null;
}

// Still renders no donor PII, as a second line of defence behind the sandbox: this is the page
// that frames third-party JS, so keep it to headings and static guidance.
export function matchingGiftsView(options: MatchingGiftsViewOptions, locale: Locale): string {
  const einLine = options.ein === null ? '' : `<p>${escapeHtml(t(locale, 'matchingGifts.einLine', { ein: options.ein }))}</p>`;
  // A link only, never the donor's employer: this page stays free of donor data (see above).
  const employerLine =
    (options.employerFormUrl ?? null) === null
      ? ''
      : `<p>${escapeHtml(t(locale, 'matchingGifts.employerPrompt'))} <a href="${escapeHtml(options.employerFormUrl!)}">${escapeHtml(t(locale, 'matchingGifts.employerLink'))}</a></p>`;
  const search =
    options.publicApiKey === null
      ? `<p>${escapeHtml(t(locale, 'matchingGifts.searchUnavailable'))}</p>`
      : `<p>${escapeHtml(t(locale, 'matchingGifts.searchHint'))}</p>${searchFrame(locale)}`;
  return `
    <h1>${escapeHtml(t(locale, 'matchingGifts.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'matchingGifts.intro'))}</p>
    <p>${escapeHtml(t(locale, 'matchingGifts.howTo'))}</p>
    ${einLine}
    ${employerLine}
    ${search}
    ${backToPortalLink(locale)}
  `;
}
