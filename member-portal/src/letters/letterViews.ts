import { escapeHtml } from '../views';
import { formatShortDate } from '../dates';
import type { TaxLetterConfig } from '../types';
import type { LetterData, LetterGift, LetterYearListing } from './loadLetterData';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';
import { doorPage, personGroup } from '../doors/layout';

// The tax letters section of the Your giving tab: one list of years per person (named only for a
// household). `listings` null: the read failed, so a note stands in for the lists.
export function lettersSection(listings: LetterYearListing[] | null, locale: Locale): string {
  const heading = `<h2>${escapeHtml(t(locale, 'home.doorLetters'))}</h2>`;
  if (listings === null) {
    return `<section id="tax-letters">${heading}<p>${escapeHtml(t(locale, 'error.lettersLoadFailed'))}</p></section>`;
  }
  const household = listings.length > 1;
  const lists = listings
    .map((listing) => {
      const items =
        listing.years.length === 0
          ? `<p>${escapeHtml(t(locale, 'letters.noneYet', { name: listing.donorName }))}</p>`
          : `<ul>${listing.years
              .map(
                (year) =>
                  `<li><a href="/${locale}/portal/letters/${encodeURIComponent(listing.donorId)}/${year}">${escapeHtml(t(locale, 'letters.yearLink', { year: String(year) }))}</a></li>`
              )
              .join('')}</ul>`;
      return household ? `<h3>${escapeHtml(listing.donorName)}</h3>${items}` : items;
    })
    .join('');
  return `<section id="tax-letters">${heading}<p>${escapeHtml(t(locale, 'letters.listIntro'))}</p>${lists}</section>`;
}

// The letter's fixed light "paper" styling, shared with the organization statement.
export const LETTER_CSS = `
      /* Fixed light "paper" look regardless of dark mode — this is a document a donor may keep
         for tax purposes (see the English-only body note above for the same reasoning). */
      .letter {
        font-family: Georgia, 'Times New Roman', serif;
        max-width: 42rem;
        margin: 0 auto;
        line-height: 1.5;
        background: var(--svbc-white);
        color: var(--svbc-black);
        padding: 1.5rem 2rem;
      }
      .letter table { border-collapse: collapse; width: 100%; }
      .letter th, .letter td { text-align: left; padding: 0.25rem 1rem 0.25rem 0; border-bottom: 1px solid #ccc; }
      .letter tr { page-break-inside: avoid; }
      .letter .total { font-weight: bold; }
      @page { size: letter; margin: 1in; }
      @media print {
        .no-print { display: none; }
      }
`;

// The letter's own body — greeting, gift table, acknowledgment statement, signature — stays
// English (spec non-goal: it's an official document a donor may keep for tax purposes). Only the
// surrounding chrome (nav links, print button) and a new disclaimer note are translated.
export function letterView(data: LetterData, taxLetter: TaxLetterConfig, generatedOn: string, locale: Locale): string {
  const giftTable = (gifts: LetterGift[]) => `
      <table>
        <thead><tr><th>Date</th><th>Amount</th></tr></thead>
        <tbody>${gifts.map((gift) => `<tr><td>${escapeHtml(formatShortDate(gift.date))}</td><td>${escapeHtml(gift.amount)}</td></tr>`).join('')}</tbody>
      </table>`;

  // A donor whose only gifts that year are separately listed has nothing to acknowledge: no
  // contributions, no total and no statement, and nothing to keep for their tax records.
  const hasContributions = data.gifts.length > 0;
  const contributions = hasContributions
    ? `<p>Thank you for supporting ${escapeHtml(taxLetter.orgLegalName)}. Our records show the
      following contributions from you during the ${data.year} calendar year:</p>
      ${giftTable(data.gifts)}
      <p class="total">Total contributions for ${data.year}: ${escapeHtml(data.totalFormatted)}</p>
      <p>${escapeHtml(data.statement)}</p>`
    : `<p>Thank you for supporting ${escapeHtml(taxLetter.orgLegalName)}.</p>`;
  const separate =
    data.separateGifts.length > 0
      ? `<p>${escapeHtml(taxLetter.separateGiftsStatement)}</p>
      ${giftTable(data.separateGifts)}`
      : '';
  const retain = hasContributions ? 'Please retain this letter for your tax records. ' : '';
  // A DAF-only letter is not a tax receipt: the donor took the deduction when they funded the
  // account, so the EIN is left off. A mixed letter keeps it for the ordinary gifts.
  const einLine = hasContributions ? `<br>\n        EIN: ${escapeHtml(taxLetter.ein)}` : '';

  return `
    <style>${LETTER_CSS}</style>
    <nav class="no-print">
      <a href="/${locale}/portal/giving#tax-letters">${escapeHtml(t(locale, 'letters.backToLetters'))}</a>
      <button type="button" onclick="window.print()">${escapeHtml(t(locale, 'letters.print'))}</button>
    </nav>
    <p class="no-print"><small>${escapeHtml(t(locale, 'letters.englishOnlyNote'))}</small></p>
    <article class="letter" lang="en">
      <header>
        <p><strong>${escapeHtml(taxLetter.orgLegalName)}</strong><br>
        ${escapeHtml(taxLetter.officeAddress)}${einLine}</p>
      </header>
      <p>${escapeHtml(generatedOn)}</p>
      <p>Dear ${escapeHtml(data.donorName)},</p>
      ${contributions}
      ${separate}
      <p>${retain}If anything here looks incorrect, contact us and we will review it.</p>
      <p>Sincerely,<br>
      ${escapeHtml(taxLetter.signatureName)}<br>
      ${escapeHtml(taxLetter.signatureTitle)}, ${escapeHtml(taxLetter.orgLegalName)}</p>
      <footer><p><small>Generated from ${escapeHtml(taxLetter.orgLegalName)}'s records on ${escapeHtml(generatedOn)}.</small></p></footer>
    </article>
  `;
}

export function lettersUnavailableView(locale: Locale): string {
  return doorPage(t(locale, 'home.doorLetters'), `<p>${escapeHtml(t(locale, 'letters.unavailable'))}</p>`, locale);
}
