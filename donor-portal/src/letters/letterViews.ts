import { escapeHtml } from '../views';
import type { TaxLetterConfig } from '../types';
import type { LetterData, LetterYearListing } from './loadLetterData';

export function lettersListView(listings: LetterYearListing[]): string {
  const sections = listings
    .map((listing) => {
      const items =
        listing.years.length === 0
          ? `<p>No letters are available yet for ${escapeHtml(listing.donorName)} — letters cover completed calendar years with at least one donation.</p>`
          : `<ul>${listing.years
              .map(
                (year) =>
                  `<li><a href="/portal/letters/${encodeURIComponent(listing.donorId)}/${year}">${year} tax letter</a></li>`
              )
              .join('')}</ul>`;
      return `<section><h2>${escapeHtml(listing.donorName)}</h2>${items}</section>`;
    })
    .join('');

  return `
    <h1>Tax documents</h1>
    <p>Each letter is a consolidated acknowledgment of the donations our records show for that
    calendar year. Open a letter and use your browser's Print option to print it or save it as
    a PDF.</p>
    ${sections}
    <p><a href="/portal">Back to your portal</a></p>
  `;
}

export function letterView(data: LetterData, taxLetter: TaxLetterConfig, generatedOn: string): string {
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
      <a href="/portal/letters">Back to tax documents</a>
      <button type="button" onclick="window.print()">Print or save as PDF</button>
    </nav>
    <article class="letter">
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

export function lettersUnavailableView(): string {
  return `
    <h1>Tax documents</h1>
    <p>Year-end tax letters are not available yet. Please check back soon, or contact us if you
    need a giving summary in the meantime.</p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}
