import { escapeHtml } from '../views';
import type { TaxLetterConfig } from '../types';
import type { LetterData, LetterYearListing } from './loadLetterData';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

export function lettersListView(listings: LetterYearListing[], locale: Locale): string {
  const sections = listings
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
      return `<section><h2>${escapeHtml(listing.donorName)}</h2>${items}</section>`;
    })
    .join('');

  return `
    <h1>${escapeHtml(t(locale, 'letters.listHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'letters.listIntro'))}</p>
    ${sections}
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}

// The letter's own body — greeting, gift table, acknowledgment statement, signature — stays
// English (spec non-goal: it's an official document a donor may keep for tax purposes). Only the
// surrounding chrome (nav links, print button) and a new disclaimer note are translated.
export function letterView(data: LetterData, taxLetter: TaxLetterConfig, generatedOn: string, locale: Locale): string {
  const rows = data.gifts
    .map((gift) => `<tr><td>${escapeHtml(gift.date)}</td><td>${escapeHtml(gift.amount)}</td></tr>`)
    .join('');

  return `
    <style>
      .letter { font-family: Georgia, 'Times New Roman', serif; max-width: 42rem; margin: 0 auto; line-height: 1.5; }
      .letter table { border-collapse: collapse; width: 100%; }
      .letter th, .letter td { text-align: left; padding: 0.25rem 1rem 0.25rem 0; border-bottom: 1px solid #ccc; }
      .letter tr { page-break-inside: avoid; }
      .letter .total { font-weight: bold; }
      @page { size: letter; margin: 1in; }
      @media print {
        .no-print { display: none; }
      }
    </style>
    <nav class="no-print">
      <a href="/${locale}/portal/letters">${escapeHtml(t(locale, 'letters.backToLetters'))}</a>
      <button type="button" onclick="window.print()">${escapeHtml(t(locale, 'letters.print'))}</button>
    </nav>
    <p class="no-print"><small>${escapeHtml(t(locale, 'letters.englishOnlyNote'))}</small></p>
    <article class="letter" lang="en">
      <header>
        <p><strong>${escapeHtml(taxLetter.orgLegalName)}</strong><br>
        ${escapeHtml(taxLetter.orgAddress)}<br>
        EIN: ${escapeHtml(taxLetter.ein)}</p>
      </header>
      <p>${escapeHtml(generatedOn)}</p>
      <p>Dear ${escapeHtml(data.donorName)},</p>
      <p>Thank you for supporting ${escapeHtml(taxLetter.orgLegalName)}. Our records show the
      following contributions from you during the ${data.year} calendar year:</p>
      <table>
        <thead><tr><th>Date</th><th>Amount</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="total">Total contributions for ${data.year}: ${escapeHtml(data.totalFormatted)}</p>
      <p>${escapeHtml(data.statement)}</p>
      <p>Please retain this letter for your tax records. If anything here looks incorrect,
      contact us and we will review it.</p>
      <p>Sincerely,<br>
      ${escapeHtml(taxLetter.signatureName)}<br>
      ${escapeHtml(taxLetter.signatureTitle)}, ${escapeHtml(taxLetter.orgLegalName)}</p>
      <footer><p><small>Generated from ${escapeHtml(taxLetter.orgLegalName)}'s records on ${escapeHtml(generatedOn)}.</small></p></footer>
    </article>
  `;
}

export function lettersUnavailableView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'letters.listHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'letters.unavailable'))}</p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}
