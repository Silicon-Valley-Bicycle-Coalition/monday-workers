import type { PortalCard } from '../card/loadCardData';
import type { Locale } from '../i18n/locales';
import { t } from '../i18n/t';
import { escapeHtml, logoImg } from '../views';

export interface MemberCardOptions {
  // The "Get a new code" form under the card: on the card door, not on the home page.
  regenerate?: boolean;
  // A lapsed membership: the card greys out and reads "Ended MM/YYYY" (ended is '' when unknown).
  lapsed?: { ended: string } | null;
}

// Single-sided wallet card — no flip, no back face (an earlier flip-card design was scrapped
// during review). Logo top-left, QR top-right (where a physical card's chip would sit), name,
// then a meta row with member #, expiry, and a tier badge. The QR's target verify URL is never
// rendered as visible text — the alt text is the only accessible label — since that URL is a
// bearer credential (see /verify/:token in routes.ts).
export function memberCardWidget(card: PortalCard, locale: Locale, options: MemberCardOptions = {}): string {
  const { data, qrSvg } = card;
  const { regenerate = true, lapsed = null } = options;
  const expiry =
    lapsed === null
      ? `<span class="label">${escapeHtml(t(locale, 'card.expiresLabel'))}</span><span class="value">${escapeHtml(data.expiryShort)}</span>`
      : `<span class="label">${escapeHtml(t(locale, 'home.cardEnded'))}</span><span class="value">${escapeHtml(lapsed.ended)}</span>`;
  const form = regenerate
    ? `
    <form class="member-card-regenerate" action="/${locale}/portal/card/${encodeURIComponent(data.donorId)}/regenerate" method="post">
      <button type="submit">${escapeHtml(t(locale, 'card.regenerate'))}</button>
    </form>`
    : '';
  return `
    <div class="member-card${lapsed === null ? '' : ' member-card-lapsed'}">
      <div class="member-card-top">
        <div class="member-card-logo">${logoImg()}</div>
        <div class="member-card-qr" role="img" aria-label="${escapeHtml(t(locale, 'card.qrAlt'))}">${qrSvg}</div>
      </div>
      <div class="member-card-name">${escapeHtml(data.donorName)}</div>
      <div class="member-card-meta">
        <div>${escapeHtml(data.memberNumber)}</div>
        <div>${expiry}</div>
        <div class="member-card-tier">${escapeHtml(data.membershipTier)}</div>
      </div>
    </div>${form}
  `;
}
