import { escapeHtml } from '../views';
import { formatShortDate } from '../dates';
import type { TaxLetterConfig } from '../types';
import type { LetterData, LetterGift, LetterYearListing } from './loadLetterData';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';
import { doorPage } from '../doors/layout';
import { LETTERHEAD_LOGO_SVG_ASSET } from '../assets/static';

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

// Letterhead geometry, from the SVBC Letter 2026 template (Box: Administrative › Forms & Templates ›
// Electronic letterhead): US Letter, a 2.3in sand band down the right edge, and body margins of
// 1.5in top, 0.9in left, 2.65in right (clear of the band) and 1.1in bottom.
const PAGE_TOP = 1.5;
const PAGE_LEFT = 0.9;
const PAGE_RIGHT = 2.65;
const PAGE_BOTTOM = 1.1;
const BAND_WIDTH = 2.3;

// A CSS string literal: escapes what could end the string or the <style> element. A newline
// becomes \a, a line break under white-space: pre-line.
function cssString(text: string): string {
  return `"${text.replace(/[\\"<>\n\r]/g, (ch) => `\\${ch.charCodeAt(0).toString(16)} `)}"`;
}

// The letter's fixed light "paper" styling, shared with the organization statement. Colours and
// type are the letterhead's (docs/design-system: svbc-gold-soft, svbc-sand, svbc-grey-text, the
// Avenir stack), not the portal's svbc-gold. Avenir isn't self-hosted (no licence to serve it), so
// machines without it fall back to Nunito Sans (self-hosted with the portal stylesheet), then the
// system sans.
//
// On screen the band is a sidebar beside the letter (a header above it on a narrow screen).
//
// In print, Chromium clips content to the page area and shrinks the page to fit anything that
// overflows it, so nothing may sit in a side or top page margin. Those margins are therefore 0:
// the body's padding stands in for them (box-decoration-break: clone repeats the top padding on
// every page), the first page's full band is absolutely placed at the page's right edge, and a
// plain sand band is position: fixed, which repeats on every printed page (the body's padding keeps
// text out from under it). Only the bottom margin
// is real, so its margin boxes can carry what the template keeps there: the gold tagline and the
// 501(c)(3) line on page one, "· page N" after, and the band's continuation on the right.
export function letterheadStyles(taxLetter: TaxLetterConfig): string {
  const lh = taxLetter.letterhead;
  const pageFooter = cssString(`${taxLetter.orgLegalName} · page `);
  const firstFootLeft = lh === undefined ? 'none' : cssString(lh.tagline.join('\n'));
  const firstFootRight = lh === undefined ? '""' : cssString(lh.nonprofitLines.join('\n'));
  const marginBox = `box-sizing: border-box; font-family: Avenir, 'Avenir Next', 'Nunito Sans', sans-serif; vertical-align: top; white-space: pre-line;
          print-color-adjust: exact; -webkit-print-color-adjust: exact;`;
  return `
      .letter {
        --letter-gold: #E8B85F;
        --letter-sand: #F0EBE8;
        --letter-grey-text: #5E6166;
        --letter-ink: #303030;
        font-family: Avenir, 'Avenir Next', 'Nunito Sans', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        font-size: 1rem;
        line-height: 1.4;
        background: #FFFFFF;
        color: var(--letter-ink);
        display: grid;
        grid-template-columns: minmax(0, 1fr) 13rem;
        grid-template-areas: 'body band' 'tagline band';
        grid-template-rows: 1fr auto;
        max-width: 48rem;
        margin: 0 auto;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
      }
      .letter-body { grid-area: body; padding: 2.5rem 2rem 1.5rem; }
      .letter-body p { margin: 0 0 0.75em; }
      .letter-body h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.75em; }
      .letter-body h2 { font-size: 1.05rem; font-weight: 600; margin: 1.25em 0 0.5em; }
      .letter table { display: table; border-collapse: collapse; width: auto; min-width: 50%; margin: 0 0 0.75em; }
      .letter th, .letter td { background: none; color: inherit; text-align: left; padding: 0.25rem 2rem 0.25rem 0; border-bottom: 1px solid #ccc; }
      .letter th { font-weight: 600; border-bottom-color: #888; }
      .letter tbody tr:nth-child(even) td { background: none; }
      .letter tr { break-inside: avoid; }
      .letter .total { font-weight: bold; }
      .letter-signature { margin-top: 1.5em !important; }
      .letter-generated { color: var(--letter-grey-text); font-size: 0.8rem; }
      .letterhead {
        grid-area: band;
        background: var(--letter-sand);
        color: var(--letter-grey-text);
        text-align: right;
        font-size: 0.8rem;
        line-height: 1.45;
        padding: 1.5rem 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
      }
      .letterhead p { margin: 0; }
      .letterhead-logo { display: block; width: 100%; height: auto; }
      .letterhead-label { text-transform: uppercase; letter-spacing: 0.06em; }
      .letterhead-people { display: flex; flex-direction: column; gap: 0.25rem; }
      .letterhead-people .letterhead-label:not(:first-child) { margin-top: 0.75rem; }
      .letterhead-nonprofit { font-style: italic; margin-top: auto !important; }
      .letter-tagline {
        grid-area: tagline;
        margin: 0;
        padding: 0 2rem 1.5rem;
        text-align: center;
        font-weight: bold;
        color: #8A6A1F;
      }
      .letterhead-band { display: none; }
      @media (max-width: 40rem) {
        .letter { grid-template-columns: 1fr; grid-template-areas: 'band' 'body' 'tagline'; grid-template-rows: auto; }
        .letterhead { gap: 1rem; }
        .letterhead-logo { width: 12rem; margin-left: auto; }
        .letterhead-people, .letterhead-nonprofit { display: none; }
        .letter-body { padding: 1.5rem 1.25rem 1rem; }
        .letter-tagline { padding: 0 1.25rem 1.25rem; }
      }
      @page {
        size: letter;
        margin: 0 0 ${PAGE_BOTTOM}in 0;
        @bottom-left {
          content: ${pageFooter} counter(page);
          width: ${8.5 - BAND_WIDTH}in;
          padding: 0.4in 0 0 ${PAGE_LEFT}in;
          font-size: 9pt;
          color: #7A7D82;
          ${marginBox}
        }
        @bottom-right {
          content: "";
          width: ${BAND_WIDTH}in;
          background: #F0EBE8;
          ${marginBox}
        }
      }
      @page :first {
        @bottom-left {
          content: ${firstFootLeft};
          padding: 0.25in ${PAGE_RIGHT - BAND_WIDTH}in 0 ${PAGE_LEFT}in;
          text-align: center;
          font-size: 12pt;
          line-height: 14pt;
          font-weight: bold;
          color: #E8B85F;
        }
        @bottom-right {
          content: ${firstFootRight};
          padding: 0.3in 0.2in 0 0;
          text-align: right;
          font-size: 9pt;
          line-height: 13pt;
          font-style: italic;
          color: #7A7D82;
        }
      }
      @media print {
        html, body { height: auto; min-height: 0; display: block; background: none; }
        main { display: block; max-width: none; padding: 0; margin: 0; }
        .no-print { display: none; }
        .letter {
          display: block;
          position: relative;
          max-width: none;
          background: none;
          box-shadow: none;
          font-size: 11pt;
          line-height: 1.35;
          color: #000000;
          --letter-grey-text: #7A7D82;
        }
        .letter-body {
          padding: ${PAGE_TOP}in ${PAGE_RIGHT}in 0 ${PAGE_LEFT}in;
          box-decoration-break: clone;
          -webkit-box-decoration-break: clone;
        }
        .letter-body p { margin: 0 0 9pt; }
        .letter-body h1 { font-size: 13pt; }
        .letter-body h2 { font-size: 11pt; }
        .letter-signature { break-inside: avoid; }
        .letter-generated { font-size: 8pt; break-before: avoid; }
        .letter-tagline, .letterhead-nonprofit { display: none; }
        .letterhead, .letterhead-band {
          position: absolute;
          top: 0;
          right: 0;
          width: ${BAND_WIDTH}in;
          height: ${11 - PAGE_BOTTOM}in;
          background: #F0EBE8;
          print-color-adjust: exact;
          -webkit-print-color-adjust: exact;
        }
        .letterhead { display: block; padding: 0; font-size: 9pt; line-height: 13pt; }
        .letterhead-logo { position: absolute; top: 0.55in; right: 0.2in; width: 1.9in; margin: 0; }
        .letterhead-contact { position: absolute; top: 1.5in; right: 0.2in; }
        .letterhead-people { display: block; position: absolute; top: 5.4in; right: 0.2in; }
        .letterhead-people p { margin: 0; }
        .letterhead-people .letterhead-label { font-size: 9.5pt; }
        .letterhead-people .letterhead-label:not(:first-child) { margin-top: 12pt; }
        /* A hair past the page area, so no seam shows above the bottom margin box. */
        .letterhead-band { display: block; position: fixed; height: ${11 - PAGE_BOTTOM + 0.02}in; }
      }
`;
}

// The letterhead band: logo, contact lines, board and executive director, 501(c)(3) line. A fork
// without a `letterhead` block gets the logo and its office address.
export function letterhead(taxLetter: TaxLetterConfig): string {
  const lines = (items: string[]) => items.map(escapeHtml).join('<br>');
  const lh = taxLetter.letterhead;
  const logo = `<img class="letterhead-logo" src="${LETTERHEAD_LOGO_SVG_ASSET.path}" width="455" height="184" alt="${escapeHtml(taxLetter.orgLegalName)}">`;
  // The print-only repeating band comes first so page one's full band paints over it.
  const band = '<div class="letterhead-band" aria-hidden="true"></div>';
  if (lh === undefined) {
    return `${band}<aside class="letterhead">${logo}<p class="letterhead-contact">${escapeHtml(taxLetter.officeAddress)}</p></aside>`;
  }
  return `${band}
      <aside class="letterhead">
        ${logo}
        <p class="letterhead-contact">${lines(lh.contactLines)}</p>
        <div class="letterhead-people">
          <p class="letterhead-label">Board of Directors</p>
          <p>${lines(lh.boardOfDirectors)}</p>
          <p class="letterhead-label">Executive Director</p>
          <p>${escapeHtml(lh.executiveDirector)}</p>
        </div>
        <p class="letterhead-nonprofit">${lines(lh.nonprofitLines)}</p>
      </aside>`;
}

// The page-one tagline, shown on screen; print draws it in the first page's bottom margin box.
export function letterheadFoot(taxLetter: TaxLetterConfig): string {
  const lh = taxLetter.letterhead;
  return lh === undefined ? '' : `<p class="letter-tagline">${lh.tagline.map(escapeHtml).join('<br>')}</p>`;
}

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
    <style>${letterheadStyles(taxLetter)}</style>
    <nav class="no-print">
      <a href="/${locale}/portal/giving#tax-letters">${escapeHtml(t(locale, 'letters.backToLetters'))}</a>
      <button type="button" onclick="window.print()">${escapeHtml(t(locale, 'letters.print'))}</button>
    </nav>
    <p class="no-print"><small>${escapeHtml(t(locale, 'letters.englishOnlyNote'))}</small></p>
    <article class="letter" lang="en">
      ${letterhead(taxLetter)}
      <div class="letter-body">
        <p>${escapeHtml(generatedOn)}</p>
        <p>Dear ${escapeHtml(data.donorName)},</p>
        ${contributions}
        ${separate}
        <p>${retain}If anything here looks incorrect, contact us and we will review it.</p>
        <p class="letter-signature">Sincerely,<br>
        ${escapeHtml(taxLetter.signatureName)}<br>
        ${escapeHtml(taxLetter.signatureTitle)}<br>
        ${escapeHtml(taxLetter.orgLegalName)}${einLine}</p>
        <p class="letter-generated">Generated from ${escapeHtml(taxLetter.orgLegalName)}'s records on ${escapeHtml(generatedOn)}.</p>
      </div>
      ${letterheadFoot(taxLetter)}
    </article>
  `;
}

export function lettersUnavailableView(locale: Locale): string {
  return doorPage(t(locale, 'home.doorLetters'), `<p>${escapeHtml(t(locale, 'letters.unavailable'))}</p>`, locale);
}
