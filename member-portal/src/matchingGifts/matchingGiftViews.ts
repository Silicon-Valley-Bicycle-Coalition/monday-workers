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
// key comes from config instead of being pasted in. A browser check of the widget under this
// page's CSP (routes.ts) is still pending the sandbox deploy.
//
// No Subresource Integrity hash on ddplugin.js, deliberately: DTD serves a mutable, unversioned
// URL they update at will, so any pinned hash silently breaks the widget on their next release.
// The compensating controls are architectural — this page renders zero donor PII (see
// matchingGiftsView below), the session cookie is httpOnly, and the whole embed is gated off by
// default. If DTD ever publishes versioned, hash-stable URLs, add SRI then.
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

export interface MatchingGiftsViewOptions {
  // Double the Donation public plugin key; null renders the page without the embedded search.
  publicApiKey: string | null;
  // SVBC's EIN from taxLetter config; null while that's still REPLACE_AFTER_SIGNOFF.
  ein: string | null;
}

// Deliberately renders no donor PII: this is the one portal page that may load third-party JS
// (the DTD widget), so it gets nothing scrapeable — headings and static guidance only. Keep it
// that way; donor data belongs on the widget-free pages.
export function matchingGiftsView(options: MatchingGiftsViewOptions, locale: Locale): string {
  const einLine = options.ein === null ? '' : `<p>${escapeHtml(t(locale, 'matchingGifts.einLine', { ein: options.ein }))}</p>`;
  const search =
    options.publicApiKey === null
      ? `<p>${escapeHtml(t(locale, 'matchingGifts.searchUnavailable'))}</p>`
      : `<p>${escapeHtml(t(locale, 'matchingGifts.searchHint'))}</p>${searchWidget(options.publicApiKey)}`;
  return `
    <h1>${escapeHtml(t(locale, 'matchingGifts.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'matchingGifts.intro'))}</p>
    <p>${escapeHtml(t(locale, 'matchingGifts.howTo'))}</p>
    ${einLine}
    ${search}
    ${backToPortalLink(locale)}
  `;
}
