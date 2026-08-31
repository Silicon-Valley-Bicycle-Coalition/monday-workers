import { escapeHtml } from '../views';
import type { CardData } from './loadCardData';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

export function verifyView(data: CardData, locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'verify.heading'))}</h1>
    <article class="card">
      <p><strong>${escapeHtml(data.donorName)}</strong></p>
      <p>${escapeHtml(t(locale, 'card.tier', { tier: data.membershipTier }))}</p>
      <p>${escapeHtml(t(locale, 'card.status', { status: data.membershipStatus }))}</p>
      <p>${escapeHtml(t(locale, 'card.expires', { expiry: data.expiryDisplay }))}</p>
    </article>
    <p><small>${escapeHtml(t(locale, 'verify.disclaimer'))}</small></p>
  `;
}

export function verifyNotValidView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'verify.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'verify.notValid'))}</p>
  `;
}
