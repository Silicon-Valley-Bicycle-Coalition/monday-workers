// The organization page and year-end statement. Neither ever shows a person's name: employee
// matches carry a date and amount only, and volunteering is a count and a total.
import type { Locale } from '../i18n/locales';
import { t } from '../i18n/t';
import { escapeHtml } from '../views';
import { doorPage } from '../doors/layout';
import { formatShortDate } from '../dates';
import { formatUsd, formatUsdText, parseAmount } from '../money';
import { giftYear } from '../letters/loadLetterData';
import { letterhead, letterheadFoot, letterheadStyles } from '../letters/letterViews';
import type { OrgGift } from '../monday/client';
import type { TaxLetterConfig } from '../types';
import type { OrgStatement } from './statement';

export interface OrgPageData {
  org: { id: string; name: string; address: string };
  gifts: OrgGift[];
  matches: OrgGift[];
  years: number[];
  // donationHistoryEnabled: false hides the giving part (as the person giving door does).
  showGiving: boolean;
  historyVisibleFromISO: string | null;
}

const newestFirst = (a: OrgGift, b: OrgGift) => b.date.localeCompare(a.date);

// The same page for every refusal: nothing here may vary by reason.
export function orgNotFoundView(locale: Locale): string {
  return doorPage(t(locale, 'error.heading'), `<p>${escapeHtml(t(locale, 'error.orgNotFound'))}</p>`, locale);
}

function giftTables(gifts: OrgGift[], locale: Locale): string {
  const byYear = new Map<number | null, OrgGift[]>();
  for (const gift of [...gifts].sort(newestFirst)) {
    const year = giftYear(gift.date);
    byYear.set(year, [...(byYear.get(year) ?? []), gift]);
  }
  return [...byYear]
    .map(([year, list]) => {
      const rows = list
        .map(
          (g) => `
        <tr>
          <td>${escapeHtml(formatShortDate(g.date))}</td>
          <td class="col-amount">${escapeHtml(formatUsdText(g.amount))}</td>
          <td>${escapeHtml(g.giftType)}</td>
        </tr>`
        )
        .join('');
      const total = formatUsd(list.reduce((sum, g) => sum + parseAmount(g.amount), 0));
      return `
    <table>
      <thead><tr><th>${escapeHtml(t(locale, 'portal.tableDate'))}</th><th class="col-amount">${escapeHtml(t(locale, 'portal.tableAmount'))}</th><th>${escapeHtml(t(locale, 'orgs.tableType'))}</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>${escapeHtml(t(locale, 'orgs.yearTotal', { year: String(year ?? '') }))}</td><td class="col-amount">${escapeHtml(total)}</td><td></td></tr></tfoot>
    </table>`;
    })
    .join('');
}

function matchTable(matches: OrgGift[], locale: Locale): string {
  const rows = [...matches]
    .sort(newestFirst)
    .map((m) => `<tr><td>${escapeHtml(formatShortDate(m.date))}</td><td class="col-amount">${escapeHtml(formatUsdText(m.amount))}</td></tr>`)
    .join('');
  return `
    <h3>${escapeHtml(t(locale, 'orgs.employeeMatch'))}</h3>
    <table>
      <thead><tr><th>${escapeHtml(t(locale, 'portal.tableDate'))}</th><th class="col-amount">${escapeHtml(t(locale, 'portal.tableAmount'))}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function historyFromNote(iso: string | null, locale: Locale): string {
  if (iso === null || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  return `<p class="door-note">${escapeHtml(t(locale, 'door.givingHistoryFrom', { date }))}</p>`;
}

export function orgPageView(data: OrgPageData, locale: Locale): string {
  const giving = data.showGiving
    ? `<section>
      <h2>${escapeHtml(t(locale, 'orgs.giving'))}</h2>
      ${data.gifts.length > 0 ? giftTables(data.gifts, locale) : ''}
      ${data.matches.length > 0 ? matchTable(data.matches, locale) : ''}
    </section>`
    : historyFromNote(data.historyVisibleFromISO, locale);
  const statements =
    data.years.length === 0
      ? `<p>${escapeHtml(t(locale, 'orgs.noStatements'))}</p>`
      : `<ul>${data.years
          .map(
            (year) =>
              `<li><a href="/${locale}/portal/org/${encodeURIComponent(data.org.id)}/statement/${year}">${escapeHtml(t(locale, 'orgs.statementLink', { year: String(year) }))}</a></li>`
          )
          .join('')}</ul>`;
  return doorPage(
    data.org.name,
    `${giving}<section><h2>${escapeHtml(t(locale, 'orgs.statements'))}</h2>${statements}</section>`,
    locale
  );
}

const giftTable = (gifts: OrgGift[]) => `
      <table>
        <thead><tr><th>Date</th><th>Amount</th><th>Type</th></tr></thead>
        <tbody>${gifts
          .map(
            (g) =>
              `<tr><td>${escapeHtml(formatShortDate(g.date))}</td><td>${escapeHtml(g.amount)}</td><td>${escapeHtml(g.giftType)}</td></tr>`
          )
          .join('')}</tbody>
      </table>`;

export interface OrgStatementOptions {
  ackOn: boolean;
  generatedOn: string;
}

// Body English like the person letter (an official document an organization may keep); only the
// chrome is translated.
export function orgStatementView(s: OrgStatement, taxLetter: TaxLetterConfig, opts: OrgStatementOptions, locale: Locale): string {
  const e = escapeHtml;
  const summary = `
      <h2>Summary</h2>
      <table>
        <thead><tr><th>Category</th><th>Gifts</th><th>Total</th></tr></thead>
        <tbody>${s.summary.map((r) => `<tr><td>${e(r.label)}</td><td>${r.count}</td><td>${e(r.total)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="total">Total support in ${s.year}: ${e(s.totalSupport)}</p>`;

  const gifts =
    s.groups.length === 0
      ? ''
      : `<h2>Gifts and payments</h2>${s.groups
          .map((g) => `<h3>${e(g.label)}</h3>${giftTable(g.gifts)}<p>Subtotal: ${e(g.subtotal)}</p>`)
          .join('')}`;

  const matching =
    s.matches.length === 0
      ? ''
      : `<h2>Employee matching</h2>
      <p>Matching gifts from ${e(s.org.name)} for its employees' gifts.</p>
      <table>
        <thead><tr><th>Date</th><th>Amount</th></tr></thead>
        <tbody>${s.matches.map((m) => `<tr><td>${e(formatShortDate(m.date))}</td><td>${e(m.amount)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="total">Total matching in ${s.year}: ${e(s.matchTotal)}</p>`;

  const volunteering =
    s.volunteering === null
      ? ''
      : `<h2>Employee volunteering</h2>
      <p>${s.volunteering.people} ${s.volunteering.people === 1 ? 'employee' : 'employees'} volunteered ${e(s.volunteering.hours)} hours with SVBC in ${s.year}.</p>`;

  let acknowledgment = '';
  if (!opts.ackOn) {
    if (s.hasDeductibleGifts) acknowledgment = `<h2>Tax acknowledgment</h2><p>A tax acknowledgment for these gifts will follow.</p>`;
  } else if (s.acknowledgment !== null) {
    const a = s.acknowledgment;
    acknowledgment = `<h2>Tax acknowledgment</h2>
      <p>${e(taxLetter.orgLegalName)}${a.gifts.length > 0 ? `<br>EIN: ${e(taxLetter.ein)}` : ''}</p>
      ${a.gifts.length > 0 ? `${giftTable(a.gifts)}<p class="total">Total deductible gifts for ${s.year}: ${e(a.total)}</p><p>${e(a.statement)}</p>` : ''}
      ${a.separateGifts.length > 0 ? `<p>${e(taxLetter.separateGiftsStatement)}</p>${giftTable(a.separateGifts)}` : ''}
      <p>The other sections are listed for ${e(s.org.name)}'s records and are not acknowledged as tax-deductible gifts.</p>`;
  }

  return `
    <style>${letterheadStyles(taxLetter)}</style>
    <nav class="no-print">
      <a href="/${locale}/portal/org/${encodeURIComponent(s.org.id)}">${e(t(locale, 'orgs.back', { name: s.org.name }))}</a>
      <button type="button" onclick="window.print()">${e(t(locale, 'orgs.print'))}</button>
    </nav>
    <article class="letter" lang="en">
      ${letterhead(taxLetter)}
      <div class="letter-body">
        <p>${e(opts.generatedOn)}</p>
        <h1>${s.year} year-end statement for ${e(s.org.name)}</h1>
        <p>${e(s.org.address)}</p>
        ${summary}
        ${gifts}
        ${matching}
        ${volunteering}
        ${acknowledgment}
        <p>If anything here looks incorrect, contact us and we will review it.</p>
        <p class="letter-signature">Sincerely,<br>
        ${e(taxLetter.signatureName)}<br>
        ${e(taxLetter.signatureTitle)}<br>
        ${e(taxLetter.orgLegalName)}</p>
        <p class="letter-generated">Generated from ${e(taxLetter.orgLegalName)}'s records on ${e(opts.generatedOn)}.</p>
      </div>
      ${letterheadFoot(taxLetter)}
    </article>
  `;
}
