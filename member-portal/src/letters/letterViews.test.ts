import { describe, it, expect } from 'vitest';
import { t } from '../i18n/t';
import { lettersListView, letterView, lettersUnavailableView } from './letterViews';
import type { LetterData } from './loadLetterData';
import type { TaxLetterConfig } from '../types';

const taxLetter: TaxLetterConfig = {
  orgLegalName: 'Silicon Valley Bicycle Coalition', ein: '00-0000000',
  officeAddress: '123 Example St, San Jose, CA 95112',
  signatureName: 'Alex Example', signatureTitle: 'Executive Director',
  plainStatement: 'No goods or services were provided.', benefitStatement: 'FMV statement.',
  benefitTiers: ['Champion'],
  excludedGiftTypes: [],
  separateGiftTypes: ['Donor Advised Fund'],
  separateGiftsStatement: 'Listed <for> your records only.',
};

const letter: LetterData = {
  donorId: 'donor-1', donorName: 'Jane <script> Example', year: 2025,
  gifts: [
    { date: '2025-01-15', amount: '$25.00' },
    { date: '2025-06-01', amount: '$50.00' },
  ],
  separateGifts: [],
  totalFormatted: '$75.00',
  statement: 'No goods or services were provided.',
};

describe('lettersListView', () => {
  it('links each donor-year pair to its letter route', () => {
    const html = lettersListView([{ donorId: 'donor-1', donorName: 'Jane', years: [2025, 2024] }], 'en');
    expect(html).toContain('/portal/letters/donor-1/2025');
    expect(html).toContain('/portal/letters/donor-1/2024');
  });

  it('shows an explicit empty state for a donor with no completed-year gifts', () => {
    const html = lettersListView([{ donorId: 'donor-2', donorName: 'Sam', years: [] }], 'en');
    expect(html).toContain('No letters are available yet');
  });

  it('locale-prefixes its year links', () => {
    const html = lettersListView([{ donorId: 'd1', donorName: 'Jane', years: [2025] }], 'vi');
    expect(html).toContain('/vi/portal/letters/d1/2025');
    expect(html).toContain('href="/vi/portal"'); // the door's "‹ Home" link
  });

  it('renders inside the door frame, naming each person only for a household', () => {
    const one = lettersListView([{ donorId: 'd1', donorName: 'Jane', years: [2025] }], 'en');
    expect(one).toContain('class="door"');
    expect(one).toContain(`<h1>${t('en', 'home.doorLetters')}</h1>`);
    expect(one).not.toContain('<h2>Jane</h2>');
    const two = lettersListView(
      [
        { donorId: 'd1', donorName: 'Jane', years: [2025] },
        { donorId: 'd2', donorName: 'Sam', years: [] },
      ],
      'en'
    );
    expect(two).toContain('<h2>Jane</h2>');
    expect(two).toContain('<h2>Sam</h2>');
  });
});

describe('letterView', () => {
  it('contains the org identity, EIN, statement, gifts, and total', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026', 'en');
    expect(html).toContain('Silicon Valley Bicycle Coalition');
    expect(html).toContain('00-0000000');
    expect(html).toContain('No goods or services were provided.');
    expect(html).toContain('2025-01-15');
    expect(html).toContain('$75.00');
    expect(html).toContain('August 24, 2026');
  });

  it('has no separate section when no gift is separately listed', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026', 'en');
    expect(html).not.toContain('your records only');
  });

  it('lists separate gifts after the total under their own statement, keeping the main statement', () => {
    const html = letterView(
      { ...letter, separateGifts: [{ date: '2025-03-01', amount: '$500.00' }] },
      taxLetter,
      'August 24, 2026',
      'en'
    );
    expect(html).toContain('Listed &lt;for&gt; your records only.');
    expect(html).toContain('$500.00');
    expect(html).toContain('No goods or services were provided.');
    expect(html.indexOf('$75.00')).toBeLessThan(html.indexOf('$500.00'));
    expect(html.indexOf('No goods or services')).toBeLessThan(html.indexOf('your records only'));
  });

  it('drops the contributions table, total, statement and tax-records line when only separate gifts exist', () => {
    const html = letterView(
      { ...letter, gifts: [], totalFormatted: '$0.00', separateGifts: [{ date: '2025-03-01', amount: '$500.00' }] },
      taxLetter,
      'August 24, 2026',
      'en'
    );
    expect(html).toContain('$500.00');
    expect(html).toContain('your records only');
    expect(html).toContain('Thank you for supporting');
    expect(html).not.toContain('Total contributions');
    expect(html).not.toContain('following contributions');
    expect(html).not.toContain('No goods or services');
    expect(html).not.toContain('retain this letter');
    expect(html).toContain('contact us');
  });

  it('omits the EIN from the DAF-only letter but keeps the org name and address', () => {
    const html = letterView(
      { ...letter, gifts: [], totalFormatted: '$0.00', separateGifts: [{ date: '2025-03-01', amount: '$500.00' }] },
      taxLetter,
      'August 24, 2026',
      'en'
    );
    expect(html).not.toContain('00-0000000');
    expect(html).not.toContain('EIN');
    expect(html).toContain('Silicon Valley Bicycle Coalition');
    expect(html).toContain('123 Example St');
  });

  it('keeps the EIN on a mixed letter that has both ordinary and separate gifts', () => {
    const html = letterView(
      { ...letter, separateGifts: [{ date: '2025-03-01', amount: '$500.00' }] },
      taxLetter,
      'August 24, 2026',
      'en'
    );
    expect(html).toContain('EIN: 00-0000000');
  });

  it('escapes donor-sourced text', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026', 'en');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('has print CSS and a print button hidden from print', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026', 'en');
    expect(html).toContain('@media print');
    expect(html).toContain('window.print()');
    expect(html).toContain('class="no-print"');
  });

  it('chrome (nav/print) is localized but the acknowledgment body stays English', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026', 'es');
    expect(html).toContain('Volver a los documentos fiscales'); // chrome is now real Spanish (es.ts is a complete translation)
    // The letter body itself is a deliberate non-goal for translation (official tax document) and
    // stays English regardless of locale.
    expect(html).toContain('Thank you for supporting');
    expect(html).toContain('Dear');
  });

  it('carries an English-only disclaimer note in the requested locale', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026', 'es');
    expect(html).toContain('se emite en inglés');
  });

  // Finding 3 (final review): the letter body is deliberately English-only even when the
  // surrounding page's <html lang> is non-English (e.g. "ja") — mark the block itself as English
  // so assistive technology doesn't mispronounce it (WCAG 2.1 SC 3.1.2, Language of Parts).
  it('marks the letter body itself as English regardless of the page locale', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026', 'ja');
    expect(html).toContain('<article class="letter" lang="en">');
  });
});

describe('letterhead', () => {
  const withLetterhead: TaxLetterConfig = {
    ...taxLetter,
    letterhead: {
      contactLines: ['bikesiliconvalley.org', '95 South Market Street'],
      boardOfDirectors: ['Liên Hoa Johnson', 'Kay <b>Cheng</b>'],
      executiveDirector: 'Alex Example',
      tagline: ['Building healthier communities', 'by bicycling'],
      nonprofitLines: ['SVBC is a 501(c)(3)', 'non-profit organization'],
    },
  };

  it('sets the band beside the letter: logo, contact, board, executive director, 501(c)(3) line', () => {
    const html = letterView(letter, withLetterhead, 'August 24, 2026', 'en');
    expect(html).toMatch(/<img class="letterhead-logo" src="\/assets\/letterhead-logo\.[0-9a-f]{16}\.svg"/);
    expect(html).toContain('bikesiliconvalley.org<br>95 South Market Street');
    expect(html).toContain('Board of Directors');
    expect(html).toContain('Liên Hoa Johnson<br>Kay &lt;b&gt;Cheng&lt;/b&gt;');
    expect(html).toContain('Executive Director</p>\n          <p>Alex Example</p>');
    expect(html).toContain('SVBC is a 501(c)(3)<br>non-profit organization');
    expect(html).toContain('<p class="letter-tagline">Building healthier communities<br>by bicycling</p>');
    // The band follows the letter onto every printed page, numbered after the first.
    expect(html).toContain('<div class="letterhead-band" aria-hidden="true"></div>');
    expect(html).toContain('content: "Silicon Valley Bicycle Coalition · page " counter(page)');
    expect(html).toContain('@page :first');
  });

  it('falls back to the logo and office address without a letterhead block', () => {
    const html = letterView(letter, taxLetter, 'August 24, 2026', 'en');
    expect(html).toContain('<p class="letterhead-contact">123 Example St, San Jose, CA 95112</p>');
    expect(html).not.toContain('Board of Directors');
    expect(html).not.toContain('<p class="letter-tagline">');
  });

  it('keeps the org name out of CSS-breaking characters in the page footer', () => {
    const html = letterView(letter, { ...taxLetter, orgLegalName: 'A "B" </style> \\ C' }, 'August 24, 2026', 'en');
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(style).toContain('content: "A \\22 B\\22  \\3c /style\\3e  \\5c  C · page " counter(page)');
  });
});

describe('lettersUnavailableView', () => {
  it('says letters are not available yet', () => {
    expect(lettersUnavailableView('en')).toContain('not available yet');
  });
});
