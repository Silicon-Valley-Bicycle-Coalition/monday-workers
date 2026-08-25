import { escapeHtml } from '../views';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

// Serializes a trusted config string into a JS literal inside an inline <script>. JSON.stringify
// handles quotes/backslashes; the extra < escape stops a "</script>" substring from
// terminating the script block early. The key is operator-set config, not user input — this is
// defense-in-depth, same spirit as passing trusted donorItemIds as GraphQL variables.
function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// NOTE: the embed shape below (DDCONF global + ddplugin.js/ddplugin.css + the
// #dd-company-name-search mount div) is written from current Double the Donation plugin
// knowledge but not verified against a live DTD account — SVBC has no subscription yet. When a
// key is provisioned, verify against DTD's current embed snippet before deploy (same caveat
// convention as the Monday query_params NOTEs in monday/client.ts).
//
// No Subresource Integrity hash on ddplugin.js, deliberately: DTD serves a mutable, unversioned
// URL they update at will, so any pinned hash silently breaks the widget on their next release.
// The compensating controls are architectural — this page renders zero donor PII (see
// matchingGiftsView below), the session cookie is httpOnly, and the whole embed is gated off by
// default. If DTD ever publishes versioned, hash-stable URLs, add SRI then.
function searchWidget(publicApiKey: string): string {
  return `
    <div id="dd-company-name-search"></div>
    <script>var DDCONF = { API_KEY: ${jsString(publicApiKey)} };</script>
    <link rel="stylesheet" href="https://doublethedonation.com/api/css/ddplugin.css" />
    <script src="https://doublethedonation.com/api/js/ddplugin.js"></script>
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
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}
