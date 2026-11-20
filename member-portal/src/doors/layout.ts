// The frames portal pages share: a tab's panel, or a stand-alone page (an organization, a letter
// that isn't available) with a way back home. Content groups under each person's name for a
// household.
import type { Locale } from '../i18n/locales';
import { t, type TranslationKey } from '../i18n/t';
import { escapeHtml } from '../views';

export function doorPage(title: string, body: string, locale: Locale): string {
  return `
    <div class="door">
      <p class="door-back"><a href="/${locale}/portal"><span aria-hidden="true">‹ </span>${escapeHtml(t(locale, 'door.home'))}</a></p>
      <h1>${escapeHtml(title)}</h1>
      ${body}
    </div>
  `;
}

// A tab's panel inside the portal frame (src/home/homeView.ts). The tab bar already names the
// page, so its h1 is for assistive tech only.
export function tabPanel(title: string, body: string): string {
  return `
    <div class="door">
      <h1 class="visually-hidden">${escapeHtml(title)}</h1>
      ${body}
    </div>
  `;
}

// One person's part of a door. A single person's needs no name: the page is theirs.
export function personGroup(name: string, body: string, showName: boolean): string {
  return `
    <section class="door-person">
      ${showName ? `<h2>${escapeHtml(name)}</h2>` : ''}
      ${body}
    </section>
  `;
}

// A short message plus a link out, so an empty section is an invitation rather than a blank table.
// Only Donate is a gold button; the rest are outline buttons, keeping one gold action per view.
export function emptyState(messageKey: TranslationKey, url: string, buttonLabelKey: TranslationKey, locale: Locale, gold = false): string {
  return `
    <div class="door-empty">
      <p>${escapeHtml(t(locale, messageKey))}</p>
      <a class="${gold ? 'cta-button' : 'outline-button'}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(locale, buttonLabelKey))}</a>
    </div>
  `;
}
