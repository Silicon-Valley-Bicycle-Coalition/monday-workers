import { describe, it, expect } from 'vitest';
import { givingTabView, type GivingDoorData } from './giving';
import type { FunraiseLinkUrls, MemberPortalData } from '../types';
import { t } from '../i18n/t';

function donor(id: string, name: string, overrides: Partial<MemberPortalData> = {}): MemberPortalData {
  return {
    id,
    name,
    membershipStatus: 'Active',
    membershipTier: 'Member',
    totalDonated: '500',
    donations: [{ date: '2026-01-01', amount: '100', description: 'Annual gift' }],
    membershipExpiry: '',
    memberSince: '',
    memberType: '',
    ...overrides,
  };
}

const noFunraise: FunraiseLinkUrls = { manageRecurringUrl: null, renewMembershipUrl: null };
const bothFunraise: FunraiseLinkUrls = {
  manageRecurringUrl: 'https://example.funraise.org/account',
  renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership&a=1',
};

function data(overrides: Partial<GivingDoorData> = {}): GivingDoorData {
  return {
    donors: [donor('donor-1', 'Jane Donor')],
    unavailableCount: 0,
    donationHistoryEnabled: true,
    impact: {},
    funraise: noFunraise,
    pledges: true,
    historyVisibleFromISO: '2020-01-01',
    ...overrides,
  };
}

describe('givingTabView', () => {
  it('shows the door title and the donation table with US-currency amounts, short dates and a total footer row', () => {
    const html = givingTabView(data(), '', 'en');
    expect(html).toContain(`<h1 class="visually-hidden">${t('en', 'home.doorGiving')}</h1>`);
    expect(html).toContain('Annual gift');
    expect(html).toContain('$100.00');
    expect(html).toContain('Jan 1, 2026');
    expect(html).not.toContain('2026-01-01');
    expect(html).toContain('<th class="col-amount">');
    expect(html).toContain('<td class="col-amount">');
    expect(html).toContain('<tfoot>');
    expect(html).toContain(t('en', 'portal.totalLabel'));
    expect(html).toContain('$500.00');
  });

  it('formats a total with a thousands separator, and keeps the table for a rollup with no itemized rows', () => {
    const html = givingTabView(data({ donors: [donor('donor-2', 'Jane Also', { totalDonated: '2500', donations: [] })] }), '', 'en');
    expect(html).toContain('$2,500.00');
    expect(html).not.toContain(t('en', 'portal.donationsEmptyMessage'));
  });

  it('shows a Donate prompt instead of an empty table for someone with nothing on file', () => {
    const html = givingTabView(data({ donors: [donor('donor-3', 'New Donor', { totalDonated: '0', donations: [] })] }), '', 'en');
    expect(html).toContain(t('en', 'portal.donationsEmptyMessage'));
    expect(html).toContain('href="https://bikesiliconvalley.org/ways-to-give"');
    expect(html).not.toContain('<tfoot>');
  });

  it('hides every gift figure while donation history is gated off', () => {
    const html = givingTabView(data({ donationHistoryEnabled: false }), '', 'en');
    expect(html).not.toContain('$100.00');
    expect(html).not.toContain('$500.00');
    expect(html).not.toContain(t('en', 'portal.totalLabel'));
    expect(html).not.toContain(t('en', 'portal.donationsEmptyMessage'));
  });

  it('shows the paired employer match under a gift, and a start-a-match link for one awaiting it', () => {
    const html = givingTabView(
      data({
        donors: [
          donor('donor-1', 'Jane Donor', {
            donations: [
              { date: '2026-01-01', amount: '100', description: 'Matched gift', match: { company: 'Acme', date: '2026-02-01', amount: '100' } },
              { date: '2026-03-01', amount: '50', description: 'Waiting gift', matchHintUrl: 'https://dtd.example/jane' },
            ],
          }),
        ],
      }),
      '',
      'en'
    );
    expect(html).toContain(t('en', 'portal.matchedBy', { company: 'Acme', date: 'Feb 1, 2026', amount: '$100.00' }));
    expect(html).toContain('href="https://dtd.example/jane"');
    expect(html).toContain(t('en', 'portal.startMatch'));
  });

  it("shows the impact summary inside that person's group only", () => {
    const html = givingTabView(
      data({
        donors: [donor('donor-1', 'Jane Donor'), donor('donor-2', 'Jane Also')],
        impact: { 'donor-2': { year: '2026', statements: ['Only for the second donor', '<script>x</script>'] } },
      }),
      '',
      'en'
    );
    const first = html.slice(html.indexOf('<h2>Jane Donor</h2>'), html.indexOf('<h2>Jane Also</h2>'));
    const second = html.slice(html.indexOf('<h2>Jane Also</h2>'));
    expect(first).not.toContain('Only for the second donor');
    expect(second).toContain(t('en', 'portal.impactHeading', { year: '2026' }));
    expect(second).toContain('<li>Only for the second donor</li>');
    expect(html).not.toContain('<script>x</script>');
  });

  it('shows the Funraise links only when configured, escaping their URLs', () => {
    expect(givingTabView(data(), '', 'en')).not.toContain(t('en', 'portal.givingLinksHeading'));
    const html = givingTabView(data({ funraise: bothFunraise }), '', 'en');
    expect(html).toContain(t('en', 'portal.givingLinksHeading'));
    expect(html).toContain('href="https://example.funraise.org/account"');
    expect(html).toContain('href="https://example.funraise.org/give?campaign=membership&amp;a=1"');
  });

  it('links pledges while that feature is on, and matching gifts always', () => {
    const on = givingTabView(data(), '', 'vi');
    expect(on).toContain('href="/vi/portal/pledges"');
    expect(on).toContain('href="/vi/portal/matching-gifts"');
    const off = givingTabView(data({ pledges: false }), '', 'vi');
    expect(off).not.toContain('/vi/portal/pledges');
    expect(off).toContain('href="/vi/portal/matching-gifts"');
  });

  it('groups a household under names, and a single person without one', () => {
    const household = givingTabView(data({ donors: [donor('donor-1', 'Jane Donor'), donor('donor-2', 'Jane Also', { donations: [{ date: '2026-02-01', amount: '25', description: 'Another gift' }] })] }), '', 'en');
    expect(household).toContain('<h2>Jane Donor</h2>');
    expect(household).toContain('<h2>Jane Also</h2>');
    expect(household.indexOf('Annual gift')).toBeLessThan(household.indexOf('<h2>Jane Also</h2>'));
    expect(household.indexOf('Another gift')).toBeGreaterThan(household.indexOf('<h2>Jane Also</h2>'));
    expect(givingTabView(data(), '', 'en')).not.toContain('<h2>Jane Donor</h2>');
  });

  it("puts a single person's section headings at h2, and a household's under each name at h3", () => {
    const impact = { 'donor-1': { year: '2025', statements: ['Taught 4,200 students'] } };
    const single = givingTabView(data({ impact }), '', 'en');
    expect(single).toContain(`<h2>${t('en', 'portal.donationsTabLabel')}</h2>`);
    expect(single).toContain(`<h2>${t('en', 'portal.impactHeading', { year: '2025' })}</h2>`);
    expect(single).not.toContain('<h3>');
    const household = givingTabView(data({ impact, donors: [donor('donor-1', 'Jane Donor'), donor('donor-2', 'Jane Also')] }), '', 'en');
    expect(household).toContain(`<h3>${t('en', 'portal.donationsTabLabel')}</h3>`);
    expect(household).toContain(`<h3>${t('en', 'portal.impactHeading', { year: '2025' })}</h3>`);
  });

  it('keeps at most one gold Donate on a household page with no gifts', () => {
    const none = { totalDonated: '0', donations: [] };
    const html = givingTabView(data({ donors: [donor('donor-1', 'Jane Donor', none), donor('donor-2', 'Jane Also', none)] }), '', 'en');
    expect((html.match(/class="cta-button/g) ?? []).length).toBe(1);
    expect((html.match(/class="outline-button/g) ?? []).length).toBe(1);
  });

  it('says from when gift history will show while it is gated off', () => {
    const html = givingTabView(data({ donationHistoryEnabled: false, historyVisibleFromISO: '2027-01-01' }), '', 'en');
    expect(html).toContain(t('en', 'door.givingHistoryFrom', { date: 'January 1, 2027' }));
    const es = givingTabView(data({ donationHistoryEnabled: false, historyVisibleFromISO: '2027-01-01' }), '', 'es');
    expect(es).toContain(t('es', 'door.givingHistoryFrom', { date: '1 de enero de 2027' }));
    expect(givingTabView(data({ historyVisibleFromISO: '2027-01-01' }), '', 'en')).not.toContain('appears here from');
    expect(givingTabView(data({ donationHistoryEnabled: false, historyVisibleFromISO: null }), '', 'en')).not.toContain('appears here from');
  });

  it('leaves the some-records note to the portal header', () => {
    expect(givingTabView(data({ unavailableCount: 1 }), '', 'en')).not.toContain(t('en', 'portal.someRecordsUnavailable'));
  });

  it('puts the tax letters section after the history and before the Funraise links', () => {
    const html = givingTabView(data({ funraise: bothFunraise }), '<section id="tax-letters">letters</section>', 'en');
    expect(html.indexOf('Annual gift')).toBeLessThan(html.indexOf('id="tax-letters"'));
    expect(html.indexOf('id="tax-letters"')).toBeLessThan(html.indexOf(t('en', 'portal.givingLinksHeading')));
  });

  it('escapes donor-sourced text', () => {
    const html = givingTabView(
      data({ donors: [donor('donor-1', '<img src=x onerror=alert(1)>', { donations: [{ date: '2026-01-01', amount: '1', description: '<script>alert(1)</script>' }] }), donor('donor-2', 'B')] }),
      '',
      'en'
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders translated copy and never the old tabs', () => {
    const html = givingTabView(data(), '', 'es');
    expect(html).toContain(t('es', 'home.doorGiving'));
    expect(html).toContain(t('es', 'portal.totalLabel'));
    expect(html).not.toContain('type="radio"');
  });

  it('prefers the matched line over the start-a-match link, and escapes company names and the hint URL', () => {
    const one = (donation: MemberPortalData['donations'][number]) => givingTabView(data({ donors: [donor('donor-1', 'Jane Donor', { donations: [donation] })] }), '', 'en');
    const base = { date: '2026-03-01', amount: '100', description: 'Annual gift' };
    expect(one({ ...base, match: { date: '2026-04-01', amount: '100', company: 'Acme Corp' }, matchHintUrl: 'https://dtd.example/abc' })).not.toContain(
      t('en', 'portal.startMatch')
    );
    const plain = one(base);
    expect(plain).not.toContain(t('en', 'portal.startMatch'));
    expect(plain).not.toContain('Matched by');
    expect(one({ ...base, match: { date: '2026-04-01', amount: '100', company: '<img src=x onerror=alert(1)>' } })).toContain('&lt;img src=x');
    expect(one({ ...base, matchHintUrl: 'https://dtd.example/a"onmouseover="x' })).not.toContain('"onmouseover=');
  });

  it('shows only the configured Funraise link', () => {
    const html = givingTabView(data({ funraise: { manageRecurringUrl: null, renewMembershipUrl: 'https://example.funraise.org/give' } }), '', 'es');
    expect(html).toContain(t('es', 'portal.renewMembershipLink'));
    expect(html).not.toContain(t('es', 'portal.manageRecurringLink'));
    expect(html).toContain(t('es', 'portal.givingLinksNote'));
  });
});
