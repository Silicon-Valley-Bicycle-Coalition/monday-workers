// The Your giving tab: each person's donation history and total (behind the history date gate),
// the impact their giving supported, their tax letters, then the Funraise links, pledges and
// matching gifts.
import type { Config, DonationRecord, DonorImpact, FunraiseLinkUrls, MemberPortalData, PortalView } from '../types';
import { funraiseLinks, pledgesEnabled } from '../config';
import { selectImpact } from '../impact/impact';
import type { Locale } from '../i18n/locales';
import { t } from '../i18n/t';
import { formatUsdText } from '../money';
import { formatShortDate } from '../dates';
import { parseAmount } from '../amounts';
import { ORG_DONATE_URL, escapeHtml } from '../views';
import { emptyState, personGroup, tabPanel } from './layout';

export interface GivingDoorData {
  // In session order; a person whose read failed is left out and counted below.
  donors: MemberPortalData[];
  unavailableCount: number;
  // false until donations.historyVisibleFromISO: no donations were read, so none are shown.
  donationHistoryEnabled: boolean;
  // The configured date history starts showing (YYYY-MM-DD), for the note shown until then; null
  // while no date is set.
  historyVisibleFromISO: string | null;
  // Keyed by donor id: a donor without an entry has no impact summary to show.
  impact: Record<string, DonorImpact>;
  funraise: FunraiseLinkUrls;
  pledges: boolean;
}

// From the header's read (src/home/loadHomeData.ts): no Monday reads of its own. "Your giving
// supported …" (v8) is per donor, from the gifts already loaded, so it follows the same date gate.
// Gated on the history flag rather than an empty donations list, so a hidden history never leaks
// a "you gave in <year>".
export function givingTabData(portal: PortalView, config: Config, locale: Locale): GivingDoorData {
  const impact: Record<string, DonorImpact> = {};
  if (portal.donationHistoryEnabled) {
    for (const donor of portal.donors) {
      const selected = selectImpact(donor.donations, config.impact, locale);
      if (selected !== null) impact[donor.id] = selected;
    }
  }
  return {
    donors: portal.donors,
    unavailableCount: portal.unavailableDonorCount ?? 0,
    donationHistoryEnabled: portal.donationHistoryEnabled,
    historyVisibleFromISO: config.donations.historyVisibleFromISO,
    impact,
    funraise: funraiseLinks(config),
    pledges: pledgesEnabled(config),
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
function hasDonations(donor: MemberPortalData): boolean {
  return donor.donations.length > 0 || (parseAmount(donor.totalDonated) ?? 0) !== 0;
}

// `gold`: only the page's first Donate prompt is the gold button; the rest are outlines.
function donationsPanel(donor: MemberPortalData, locale: Locale, gold: boolean): string {
  if (!hasDonations(donor)) {
    return emptyState('portal.donationsEmptyMessage', ORG_DONATE_URL, 'portal.donateButton', locale, gold);
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
function impactSummary(impact: DonorImpact, locale: Locale, heading: 'h2' | 'h3'): string {
  return `
      <${heading}>${escapeHtml(t(locale, 'portal.impactHeading', { year: impact.year }))}</${heading}>
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

// "Your gift history appears here from January 1, 2027." while the history gate is closed.
function historyFromNote(data: GivingDoorData, locale: Locale): string {
  const iso = data.historyVisibleFromISO;
  if (data.donationHistoryEnabled || iso === null || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  return `<p class="door-note">${escapeHtml(t(locale, 'door.givingHistoryFrom', { date }))}</p>`;
}

// `letters` is the tax-letters section (src/letters/letterViews.ts), '' when letters are off.
export function givingTabView(data: GivingDoorData, letters: string, locale: Locale): string {
  const household = data.donors.length + data.unavailableCount > 1;
  // Under a person's name (h2) on a household page; directly under the tab otherwise.
  const heading = household ? 'h3' : 'h2';
  const firstEmpty = data.donationHistoryEnabled ? data.donors.find((donor) => !hasDonations(donor)) : undefined;
  const groups = data.donors
    .map((donor) => {
      const history = data.donationHistoryEnabled
        ? `<${heading}>${escapeHtml(t(locale, 'portal.donationsTabLabel'))}</${heading}>${donationsPanel(donor, locale, donor === firstEmpty)}`
        : '';
      const impact = data.impact[donor.id];
      const body = `${history}${impact ? impactSummary(impact, locale, heading) : ''}`;
      return body === '' ? '' : personGroup(donor.name, body, household);
    })
    .join('');
  return tabPanel(
    t(locale, 'home.doorGiving'),
    `${historyFromNote(data, locale)}${groups}${letters}${funraiseSection(data.funraise, locale)}${moreLinks(data.pledges, locale)}`
  );
}
