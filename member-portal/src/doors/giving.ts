// The giving door: each person's donation history and total (behind the history date gate), the
// impact their giving supported, then the Funraise links, pledges and matching gifts.
import type { AppDeps } from '../routes';
import type { DonationRecord, DonorImpact, FunraiseLinkUrls, MemberPortalData } from '../types';
import { donationHistoryEnabled, funraiseLinks, pledgesEnabled } from '../config';
import { loadPortalData } from '../portal/loadPortalData';
import { selectImpact } from '../impact/impact';
import type { Locale } from '../i18n/locales';
import { t } from '../i18n/t';
import { formatUsdText } from '../money';
import { formatShortDate } from '../dates';
import { parseAmount } from '../amounts';
import { ORG_DONATE_URL, escapeHtml, someRecordsUnavailableNote } from '../views';
import { doorPage, emptyState, personGroup } from './layout';

export interface GivingDoorData {
  // In session order; a person whose read failed is left out and counted below.
  donors: MemberPortalData[];
  unavailableCount: number;
  // false until donations.historyVisibleFromISO: no donations were read, so none are shown.
  donationHistoryEnabled: boolean;
  // Keyed by donor id: a donor without an entry has no impact summary to show.
  impact: Record<string, DonorImpact>;
  funraise: FunraiseLinkUrls;
  pledges: boolean;
}

type GivingDeps = Pick<AppDeps, 'monday' | 'config' | 'now'>;

export async function loadGivingDoor(donorItemIds: string[], deps: GivingDeps, locale: Locale): Promise<GivingDoorData> {
  const historyEnabled = donationHistoryEnabled(deps.config, deps.now());
  // Throws only when no one loads (the route's error page).
  const data = await loadPortalData(donorItemIds, deps.monday, undefined, historyEnabled, { discounts: false });

  // "Your giving supported …" (v8): per donor, from the gifts already loaded, so it follows the
  // same date gate and costs no extra Monday read. Gated here rather than on an empty donations
  // list, so a hidden history never leaks a "you gave in <year>".
  const impact: Record<string, DonorImpact> = {};
  if (data.donationHistoryEnabled) {
    for (const donor of data.donors) {
      const selected = selectImpact(donor.donations, deps.config.impact, locale);
      if (selected !== null) impact[donor.id] = selected;
    }
  }

  return {
    donors: data.donors,
    unavailableCount: data.unavailableDonorCount ?? 0,
    donationHistoryEnabled: data.donationHistoryEnabled,
    impact,
    funraise: funraiseLinks(deps.config),
    pledges: pledgesEnabled(deps.config),
  };
}

function donationRow(donation: DonationRecord, locale: Locale): string {
  return `
    <tr>
      <td>${escapeHtml(formatShortDate(donation.date))}</td>
      <td class="col-amount">${escapeHtml(formatUsdText(donation.amount))}</td>
      <td>${escapeHtml(donation.description)}${matchLine(donation, locale)}</td>
    </tr>
  `;
}

// Under the description: the paired employer match, or (for a gift still waiting on the donor) a
// link to start one. Every interpolated value is escaped; the link opens the donor's own DTD page.
function matchLine(donation: DonationRecord, locale: Locale): string {
  if (donation.match) {
    const text = t(locale, 'portal.matchedBy', {
      company: donation.match.company,
      date: formatShortDate(donation.match.date),
      amount: formatUsdText(donation.match.amount),
    });
    return `<div class="match-line">${escapeHtml(text)}</div>`;
  }
  if (donation.matchHintUrl) {
    return `<div class="match-line"><a href="${escapeHtml(donation.matchHintUrl)}" target="_blank" rel="noopener">${escapeHtml(t(locale, 'portal.startMatch'))}</a></div>`;
  }
  return '';
}

// The itemized table when there's something to show, otherwise a Donate prompt. "Something to
// show" is donations.length > 0 OR a nonzero totalDonated: a donor can have a nonzero lifetime
// rollup with no itemized rows on file (e.g. older gifts never synced as line items), and that
// donor has clearly already given, so "you haven't donated yet" would be wrong for them.
function donationsPanel(donor: MemberPortalData, locale: Locale): string {
  const hasDonations = donor.donations.length > 0 || (parseAmount(donor.totalDonated) ?? 0) !== 0;
  if (!hasDonations) {
    return emptyState('portal.donationsEmptyMessage', ORG_DONATE_URL, 'portal.donateButton', locale, true);
  }
  return `
    <table>
      <thead>
        <tr><th>${escapeHtml(t(locale, 'portal.tableDate'))}</th><th class="col-amount">${escapeHtml(t(locale, 'portal.tableAmount'))}</th><th>${escapeHtml(t(locale, 'portal.tableDescription'))}</th></tr>
      </thead>
      <tbody>
        ${donor.donations.map((d) => donationRow(d, locale)).join('')}
      </tbody>
      <tfoot>
        <tr>
          <td>${escapeHtml(t(locale, 'portal.totalLabel'))}</td>
          <td class="col-amount">${escapeHtml(formatUsdText(donor.totalDonated))}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  `;
}

// "Your giving supported …" for the one year selectImpact picked for this donor. Statements are
// operator-set config, not donor input; escaped anyway, like every other string the portal renders.
function impactSummary(impact: DonorImpact, locale: Locale): string {
  return `
      <h3>${escapeHtml(t(locale, 'portal.impactHeading', { year: impact.year }))}</h3>
      <p>${escapeHtml(t(locale, 'portal.impactIntro', { year: impact.year }))}</p>
      <ul>
        ${impact.statements.map((statement) => `<li>${escapeHtml(statement)}</li>`).join('')}
      </ul>
  `;
}

// Deep links out to Funraise's own donor-account and checkout surfaces — deliberately links,
// not embedded flows, so recurring-gift changes and renewal payments happen entirely on
// Funraise's PCI-scoped pages, never in this Worker (IT Requests item 12893519422). Each link
// renders only when its URL is configured (see funraiseLinks() in config.ts); with neither
// configured the whole section disappears.
function funraiseSection(links: FunraiseLinkUrls, locale: Locale): string {
  const rows = [
    links.manageRecurringUrl !== null
      ? `<li><a href="${escapeHtml(links.manageRecurringUrl)}" rel="noopener noreferrer">${escapeHtml(t(locale, 'portal.manageRecurringLink'))}</a></li>`
      : '',
    links.renewMembershipUrl !== null
      ? `<li><a href="${escapeHtml(links.renewMembershipUrl)}" rel="noopener noreferrer">${escapeHtml(t(locale, 'portal.renewMembershipLink'))}</a></li>`
      : '',
  ].join('');
  if (rows === '') return '';
  return `
    <section>
      <h2>${escapeHtml(t(locale, 'portal.givingLinksHeading'))}</h2>
      <ul>${rows}</ul>
      <p>${escapeHtml(t(locale, 'portal.givingLinksNote'))}</p>
    </section>
  `;
}

// Pledges while that feature is configured; the matching-gifts page always renders.
function moreLinks(pledges: boolean, locale: Locale): string {
  const pledgeItem = pledges ? `<li><a href="/${locale}/portal/pledges">${escapeHtml(t(locale, 'portal.pledgesLink'))}</a></li>` : '';
  return `<ul class="door-links">${pledgeItem}<li><a href="/${locale}/portal/matching-gifts">${escapeHtml(t(locale, 'portal.matchingGiftsLink'))}</a></li></ul>`;
}

export function givingDoorView(data: GivingDoorData, locale: Locale): string {
  const household = data.donors.length + data.unavailableCount > 1;
  const groups = data.donors
    .map((donor) => {
      const history = data.donationHistoryEnabled
        ? `<h3>${escapeHtml(t(locale, 'portal.donationsTabLabel'))}</h3>${donationsPanel(donor, locale)}`
        : '';
      const impact = data.impact[donor.id];
      const body = `${history}${impact ? impactSummary(impact, locale) : ''}`;
      return body === '' ? '' : personGroup(donor.name, body, household);
    })
    .join('');
  return doorPage(
    t(locale, 'home.doorGiving'),
    `${someRecordsUnavailableNote(data.unavailableCount, locale)}${groups}${funraiseSection(data.funraise, locale)}${moreLinks(data.pledges, locale)}`,
    locale
  );
}
