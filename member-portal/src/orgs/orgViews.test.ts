import { describe, it, expect } from 'vitest';
import { orgNotFoundView, orgPageView, orgStatementView } from './orgViews';
import { t } from '../i18n/t';
import type { OrgStatement } from './statement';
import type { TaxLetterConfig } from '../types';

const taxLetter = {
  orgLegalName: 'Silicon Valley Bicycle Coalition', ein: '00-0000000', officeAddress: '123 Example St',
  signatureName: 'Alex Example', signatureTitle: 'Executive Director', plainStatement: 'No goods or services.',
  benefitStatement: 'b', benefitTiers: [], excludedGiftTypes: [], separateGiftTypes: [], separateGiftsStatement: 'Separate <gifts>.',
} as TaxLetterConfig;

const org = { id: 'o1', name: 'Acme <Bikes>', address: '1 Main St' };
const gift = (itemId: string, date: string, amount: string, giftType = 'Donation') => ({ itemId, date, amount, giftType, description: `d-${itemId}` });

describe('orgPageView', () => {
  const base = {
    org,
    gifts: [gift('a', '2025-01-05', '$10.00'), gift('b', '2026-02-05', '$20.00'), gift('c', '2025-09-05', '$30.00')],
    matches: [{ ...gift('m', '2025-03-01', '$5.00', 'Matching'), description: 'PRIVATE NAME' }],
    years: [2025],
    showGiving: true,
    historyVisibleFromISO: null,
  };

  it('escapes the name, lists newest first with a total per year', () => {
    const html = orgPageView(base, 'en');
    expect(html).toContain('Acme &lt;Bikes&gt;');
    expect(html.indexOf('d-b')).toBeLessThan(html.indexOf('d-c'));
    expect(html.indexOf('d-c')).toBeLessThan(html.indexOf('d-a'));
    expect(html).toContain('2025 total');
    expect(html).toContain('$40.00');
    expect(html).toContain('Employee match');
    expect(html).not.toContain('PRIVATE NAME');
  });

  it('omits the employee match part when there are none', () => {
    expect(orgPageView({ ...base, matches: [] }, 'en')).not.toContain('Employee match');
  });

  it('omits giving when the history gate is closed, noting when it opens', () => {
    const html = orgPageView({ ...base, showGiving: false, historyVisibleFromISO: '2027-01-01' }, 'en');
    expect(html).not.toContain('d-a');
    expect(html).toContain('January 1, 2027');
    expect(html).toContain('statement/2025');
  });

  it('says so when there are no statements', () => {
    expect(orgPageView({ ...base, years: [] }, 'en')).toContain(t('en', 'orgs.noStatements'));
  });
});

describe('orgStatementView', () => {
  const statement: OrgStatement = {
    org, year: 2025,
    summary: [{ label: 'Donation', count: 1, total: '$100.00' }],
    totalSupport: '$100.00',
    groups: [{ label: 'Donation', gifts: [gift('a', '2025-01-05', '$100.00')], subtotal: '$100.00' }],
    matches: [], matchTotal: '$0.00', volunteering: { people: 4, hours: '12' },
    acknowledgment: { gifts: [gift('a', '2025-01-05', '$100.00')], separateGifts: [gift('s', '2025-02-05', '$7.00', 'DAF')], total: '$100.00', statement: 'PLAIN' },
  };

  it('omits empty sections and shows volunteering as a count', () => {
    const html = orgStatementView(statement, taxLetter, { ackOn: true, generatedOn: 'January 1, 2026' }, 'en');
    expect(html).not.toContain('Employee matching');
    expect(html).toContain('4 employees volunteered 12 hours');
    expect(html).toContain('Separate &lt;gifts&gt;.');
    expect(html).toContain('Acme &lt;Bikes&gt;');
  });

  it('translates the chrome but not the body', () => {
    const html = orgStatementView(statement, taxLetter, { ackOn: false, generatedOn: 'January 1, 2026' }, 'es');
    expect(html).toContain(t('es', 'orgs.print'));
    expect(html).toContain('A tax acknowledgment for these gifts will follow.');
  });
});

describe('orgNotFoundView', () => {
  it('names nothing about the organization', () => {
    expect(orgNotFoundView('en')).toContain(t('en', 'error.orgNotFound'));
  });
});
