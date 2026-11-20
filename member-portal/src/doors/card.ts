// The member card widget (shown in the portal header), "Get a new code" for each card (on the
// Profile tab), and the Benefits tab: the discount list and the organizations the session manages.
import type { AppDeps } from '../routes';
import type { DiscountOrganization, MemberPortalData } from '../types';
import type { PortalCard } from '../card/loadCardData';
import { buildCardData } from '../card/loadCardData';
import { generateQrSvg } from '../card/qr';
import { getOrCreateCardToken } from '../card/getOrCreateCardToken';
import type { Locale } from '../i18n/locales';
import { t } from '../i18n/t';
import { errorText } from '../logSafe';
import { escapeHtml, logoImg } from '../views';
import { tabPanel } from './layout';
import type { HomeData } from '../home/loadHomeData';
import { orgSection } from '../home/homeView';

export interface MemberCardOptions {
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
  const { lapsed = null } = options;
  const expiry =
    lapsed === null
      ? `<span class="label">${escapeHtml(t(locale, 'card.expiresLabel'))}</span><span class="value">${escapeHtml(data.expiryShort)}</span>`
      : `<span class="label">${escapeHtml(t(locale, 'home.cardEnded'))}</span><span class="value">${escapeHtml(lapsed.ended)}</span>`;
  return `
    <div class="member-card${lapsed === null ? '' : ' member-card-lapsed'}">
      <div class="member-card-top">
        <div class="member-card-logo">${logoImg(undefined, true)}</div>
        <div class="member-card-qr" role="img" aria-label="${escapeHtml(t(locale, 'card.qrAlt'))}">${qrSvg}</div>
      </div>
      <div class="member-card-name">${escapeHtml(data.donorName)}</div>
      <div class="member-card-meta">
        <div>${escapeHtml(data.memberNumber)}</div>
        <div>${expiry}</div>
        <div class="member-card-tier">${escapeHtml(data.membershipTier)}</div>
      </div>
    </div>
  `;
}

// A card token failure costs that person their card, never the page.
export async function cardFor(donor: MemberPortalData, deps: Pick<AppDeps, 'config' | 'now' | 'cardTokenStore'>): Promise<PortalCard | null> {
  try {
    const token = await getOrCreateCardToken(donor.id, deps.cardTokenStore, deps.now);
    return { data: buildCardData(donor), qrSvg: generateQrSvg(`${deps.config.auth.portalBaseUrl}/verify/${token}`) };
  } catch (err) {
    console.error(`member-portal card failed for donor "${donor.id}": ${errorText(err)}`);
    return null;
  }
}

// "10/2026" for a lapsed card ('' when the end date isn't a YYYY-MM-DD date).
export function endedMonth(until: string): string {
  const iso = until.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) return '';
  return `${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function discountRow(discount: DiscountOrganization): string {
  return `<li>${escapeHtml(discount.name)}: ${escapeHtml(discount.discountOffered)}</li>`;
}

// "Get a new code" for each card the header shows: a code someone else has a copy of stops working.
// Rendered on the Profile tab.
export function cardCodeSection(data: HomeData, locale: Locale): string {
  const withCards = data.people.filter((e) => e.card !== null);
  if (withCards.length === 0) return '';
  const household = data.people.length + data.unavailableCount > 1;
  const forms = withCards
    .map(({ person, card }) => {
      const label = household ? `<span class="card-code-name">${escapeHtml(person.firstName)}</span>` : '';
      return `<form class="member-card-regenerate" action="/${locale}/portal/card/${encodeURIComponent(card!.data.donorId)}/regenerate" method="post">${label}<button type="submit">${escapeHtml(t(locale, 'card.regenerate'))}</button></form>`;
    })
    .join('');
  return `
    <section>
      <h2>${escapeHtml(t(locale, withCards.length > 1 ? 'home.defaultHeadlineMany' : 'home.defaultHeadline'))}</h2>
      <p>${escapeHtml(t(locale, 'card.newCodeIntro'))}</p>
      ${forms}
    </section>`;
}

// The Benefits tab: the shop discount list, then the organizations the session manages. Everything
// comes from the header's read.
export function benefitsTabView(data: HomeData, locale: Locale): string {
  const discounts = data.portal.discounts;
  const discountSection =
    discounts === null
      ? ''
      : `<section id="discounts">
      <h2>${escapeHtml(t(locale, 'portal.discountsHeading'))}</h2>
      <ul>
        ${discounts.map(discountRow).join('')}
      </ul>
    </section>`;
  return tabPanel(t(locale, 'tabs.benefits'), `${discountSection}${orgSection(data.orgs, locale)}`);
}
