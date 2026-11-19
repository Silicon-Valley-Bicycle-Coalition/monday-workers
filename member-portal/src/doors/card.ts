// The card door: each person's member card with its QR and "Get a new code", then the discount
// list. The card widget itself is shared with the home page, which shows it without the form.
import type { AppDeps } from '../routes';
import type { DiscountOrganization, MemberPortalData } from '../types';
import type { PortalCard } from '../card/loadCardData';
import { buildCardData } from '../card/loadCardData';
import { generateQrSvg } from '../card/qr';
import { getOrCreateCardToken } from '../card/getOrCreateCardToken';
import { cardEnabled } from '../config';
import { loadPortalData } from '../portal/loadPortalData';
import type { Locale } from '../i18n/locales';
import { t } from '../i18n/t';
import { errorText } from '../logSafe';
import { escapeHtml, logoImg, someRecordsUnavailableNote } from '../views';
import { doorPage, personGroup } from './layout';
import { membershipEnded, todayInLosAngeles } from '../home/homeState';

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

type CardDeps = Pick<AppDeps, 'monday' | 'config' | 'now' | 'cardTokenStore'>;

// A card token failure costs that person their card, never the page.
export async function cardFor(donor: MemberPortalData, deps: Pick<CardDeps, 'config' | 'now' | 'cardTokenStore'>): Promise<PortalCard | null> {
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

// No membership on file: a blank Membership Status (with or without a Tier). Covers the home page's
// "never a member" rule (homeState.ts: status and tier both blank); a card for a blank status would
// show a member number with no status to anyone scanning it.
function neverAMember(donor: MemberPortalData): boolean {
  return donor.membershipStatus.trim() === '';
}

export interface CardDoorPerson {
  id: string;
  name: string;
  // null when the card feature is off, the person never joined, or their token failed.
  card: PortalCard | null;
  notMember: boolean;
  // "MM/YYYY" ('' when unknown) for an ended membership (membershipEnded), else null.
  lapsedEnded: string | null;
}

export interface CardDoorData {
  people: CardDoorPerson[];
  // null when the discount read failed.
  discounts: DiscountOrganization[] | null;
  unavailableCount: number;
}

export async function loadCardDoor(donorItemIds: string[], deps: CardDeps): Promise<CardDoorData> {
  // Membership fields and the discount list; no donations. Throws only when no one loads.
  const data = await loadPortalData(donorItemIds, deps.monday, undefined, false);
  const withCards = cardEnabled(deps.config);
  const today = todayInLosAngeles(deps.now());
  const people = await Promise.all(
    data.donors.map(async (donor) => {
      const notMember = neverAMember(donor);
      return {
        id: donor.id,
        name: donor.name,
        card: withCards && !notMember ? await cardFor(donor, deps) : null,
        notMember,
        // The home page's rule (Lapsed, or a Member Until already past; never Lifetime).
        lapsedEnded: membershipEnded({ status: donor.membershipStatus, tier: donor.membershipTier, until: donor.membershipExpiry }, today)
          ? endedMonth(donor.membershipExpiry)
          : null,
      };
    })
  );
  return { people, discounts: data.discounts, unavailableCount: data.unavailableDonorCount ?? 0 };
}

function discountRow(discount: DiscountOrganization): string {
  return `<li>${escapeHtml(discount.name)}: ${escapeHtml(discount.discountOffered)}</li>`;
}

export function cardDoorView(data: CardDoorData, locale: Locale): string {
  const household = data.people.length + data.unavailableCount > 1;
  const groups = data.people
    .map((person) => {
      const body = person.notMember
        ? `<div class="home-not-member"><p>${escapeHtml(t(locale, 'home.notMember'))}</p></div>`
        : person.card === null
          ? ''
          : memberCardWidget(person.card, locale, { lapsed: person.lapsedEnded === null ? null : { ended: person.lapsedEnded } });
      return body === '' ? '' : personGroup(person.name, body, household);
    })
    .join('');
  const discounts =
    data.discounts === null
      ? ''
      : `<section>
      <h2>${escapeHtml(t(locale, 'portal.discountsHeading'))}</h2>
      <ul>
        ${data.discounts.map(discountRow).join('')}
      </ul>
    </section>`;
  return doorPage(t(locale, 'home.doorCard'), `${someRecordsUnavailableNote(data.unavailableCount, locale)}${groups}${discounts}`, locale);
}
