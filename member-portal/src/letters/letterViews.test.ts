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
};

const letter: LetterData = {
  donorId: 'donor-1', donorName: 'Jane <script> Example', year: 2025,
  gifts: [
    { date: '2025-01-15', amount: '$25.00' },
    { date: '2025-06-01', amount: '$50.00' },
  ],
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
