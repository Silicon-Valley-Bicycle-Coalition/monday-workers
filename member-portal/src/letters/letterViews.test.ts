import { describe, it, expect } from 'vitest';
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
    expect(html).toContain('href="/vi/portal"'); // "back to your portal" link
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

describe('lettersUnavailableView', () => {
  it('says letters are not available yet', () => {
    expect(lettersUnavailableView('en')).toContain('not available yet');
  });
});
