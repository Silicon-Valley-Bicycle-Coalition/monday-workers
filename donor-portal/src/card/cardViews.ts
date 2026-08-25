import { escapeHtml } from '../views';
import type { CardData } from './loadCardData';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

export function cardView(data: CardData, verifyUrl: string, qrSvg: string, locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'card.heading'))}</h1>
    <article class="card">
      <p><strong>${escapeHtml(data.donorName)}</strong></p>
      <p>${escapeHtml(data.memberNumber)}</p>
      <p>${escapeHtml(t(locale, 'card.tier', { tier: data.membershipTier }))}</p>
      <p>${escapeHtml(t(locale, 'card.status', { status: data.membershipStatus }))}</p>
      <p>${escapeHtml(t(locale, 'card.expires', { expiry: data.expiryDisplay }))}</p>
      <div class="qr">${qrSvg}</div>
      <p><a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>
      <p><small>${escapeHtml(t(locale, 'card.scanHint'))}</small></p>
    </article>
    <form action="/${locale}/portal/card/${encodeURIComponent(data.donorId)}/regenerate" method="post">
      <button type="submit">${escapeHtml(t(locale, 'card.regenerate'))}</button>
    </form>
    <p><small>${escapeHtml(t(locale, 'card.regenerateHint'))}</small></p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}

export function cardUnavailableView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'card.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'card.unavailable'))}</p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}

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
