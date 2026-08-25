import { escapeHtml } from '../views';
import type { CardData } from './loadCardData';

export function cardView(data: CardData, verifyUrl: string, qrSvg: string): string {
  return `
    <h1>Your membership card</h1>
    <article class="card">
      <p><strong>${escapeHtml(data.donorName)}</strong></p>
      <p>${escapeHtml(data.memberNumber)}</p>
      <p>Tier: ${escapeHtml(data.membershipTier)}</p>
      <p>Status: ${escapeHtml(data.membershipStatus)}</p>
      <p>Expires: ${escapeHtml(data.expiryDisplay)}</p>
      <div class="qr">${qrSvg}</div>
      <p><a href="${escapeHtml(verifyUrl)}">${escapeHtml(verifyUrl)}</a></p>
      <p><small>Show this card, or let a shop scan the QR code or open the link above, to confirm your membership.</small></p>
    </article>
    <form action="/portal/card/${encodeURIComponent(data.donorId)}/regenerate" method="post">
      <button type="submit">Regenerate card</button>
    </form>
    <p><small>Regenerating invalidates the old QR code and link immediately — use this if you think your card link has leaked.</small></p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}

export function cardUnavailableView(): string {
  return `
    <h1>Your membership card</h1>
    <p>Digital membership cards are not available yet. Please check back soon.</p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}

export function verifyView(data: CardData): string {
  return `
    <h1>Membership verification</h1>
    <article class="card">
      <p><strong>${escapeHtml(data.donorName)}</strong></p>
      <p>Tier: ${escapeHtml(data.membershipTier)}</p>
      <p>Status: ${escapeHtml(data.membershipStatus)}</p>
      <p>Expires: ${escapeHtml(data.expiryDisplay)}</p>
    </article>
    <p><small>This information is fetched live from our records.</small></p>
  `;
}

export function verifyNotValidView(): string {
  return `
    <h1>Membership verification</h1>
    <p>This card is not valid. It may have been regenerated or is no longer active.</p>
  `;
}
