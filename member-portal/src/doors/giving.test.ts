import { describe, it, expect } from 'vitest';
import { givingDoorView, type GivingDoorData } from './giving';
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
    ...overrides,
  };
}

describe('givingDoorView', () => {
  it('shows the door title and the donation table with US-currency amounts, short dates and a total footer row', () => {
    const html = givingDoorView(data(), 'en');
    expect(html).toContain(`<h1>${t('en', 'home.doorGiving')}</h1>`);
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
    const html = givingDoorView(data({ donors: [donor('donor-2', 'Jane Also', { totalDonated: '2500', donations: [] })] }), 'en');
    expect(html).toContain('$2,500.00');
    expect(html).not.toContain(t('en', 'portal.donationsEmptyMessage'));
  });

  it('shows a Donate prompt instead of an empty table for someone with nothing on file', () => {
    const html = givingDoorView(data({ donors: [donor('donor-3', 'New Donor', { totalDonated: '0', donations: [] })] }), 'en');
    expect(html).toContain(t('en', 'portal.donationsEmptyMessage'));
    expect(html).toContain('href="https://bikesiliconvalley.org/ways-to-give"');
    expect(html).not.toContain('<tfoot>');
  });

  it('hides every gift figure while donation history is gated off', () => {
    const html = givingDoorView(data({ donationHistoryEnabled: false }), 'en');
    expect(html).not.toContain('$100.00');
    expect(html).not.toContain('$500.00');
    expect(html).not.toContain(t('en', 'portal.totalLabel'));
    expect(html).not.toContain(t('en', 'portal.donationsEmptyMessage'));
  });

  it('shows the paired employer match under a gift, and a start-a-match link for one awaiting it', () => {
    const html = givingDoorView(
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
      'en'
    );
    expect(html).toContain(t('en', 'portal.matchedBy', { company: 'Acme', date: 'Feb 1, 2026', amount: '$100.00' }));
    expect(html).toContain('href="https://dtd.example/jane"');
    expect(html).toContain(t('en', 'portal.startMatch'));
  });

  it("shows the impact summary inside that person's group only", () => {
    const html = givingDoorView(
      data({
        donors: [donor('donor-1', 'Jane Donor'), donor('donor-2', 'Jane Also')],
        impact: { 'donor-2': { year: '2026', statements: ['Only for the second donor', '<script>x</script>'] } },
      }),
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
    expect(givingDoorView(data(), 'en')).not.toContain(t('en', 'portal.givingLinksHeading'));
    const html = givingDoorView(data({ funraise: bothFunraise }), 'en');
    expect(html).toContain(t('en', 'portal.givingLinksHeading'));
    expect(html).toContain('href="https://example.funraise.org/account"');
    expect(html).toContain('href="https://example.funraise.org/give?campaign=membership&amp;a=1"');
  });

  it('links pledges while that feature is on, and matching gifts always', () => {
    const on = givingDoorView(data(), 'vi');
    expect(on).toContain('href="/vi/portal/pledges"');
    expect(on).toContain('href="/vi/portal/matching-gifts"');
    const off = givingDoorView(data({ pledges: false }), 'vi');
    expect(off).not.toContain('/vi/portal/pledges');
    expect(off).toContain('href="/vi/portal/matching-gifts"');
  });

  it('groups a household under names, and a single person without one', () => {
    const household = givingDoorView(data({ donors: [donor('donor-1', 'Jane Donor'), donor('donor-2', 'Jane Also', { donations: [{ date: '2026-02-01', amount: '25', description: 'Another gift' }] })] }), 'en');
    expect(household).toContain('<h2>Jane Donor</h2>');
    expect(household).toContain('<h2>Jane Also</h2>');
    expect(household.indexOf('Annual gift')).toBeLessThan(household.indexOf('<h2>Jane Also</h2>'));
    expect(household.indexOf('Another gift')).toBeGreaterThan(household.indexOf('<h2>Jane Also</h2>'));
    expect(givingDoorView(data(), 'en')).not.toContain('<h2>Jane Donor</h2>');
  });

  it('tells the member when some records could not be loaded', () => {
    expect(givingDoorView(data({ unavailableCount: 1 }), 'en')).toContain(t('en', 'portal.someRecordsUnavailable'));
    expect(givingDoorView(data(), 'en')).not.toContain(t('en', 'portal.someRecordsUnavailable'));
  });

  it('escapes donor-sourced text', () => {
    const html = givingDoorView(
      data({ donors: [donor('donor-1', '<img src=x onerror=alert(1)>', { donations: [{ date: '2026-01-01', amount: '1', description: '<script>alert(1)</script>' }] }), donor('donor-2', 'B')] }),
      'en'
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders translated copy and never the old tabs', () => {
    const html = givingDoorView(data(), 'es');
    expect(html).toContain(t('es', 'home.doorGiving'));
    expect(html).toContain(t('es', 'portal.totalLabel'));
    expect(html).not.toContain('type="radio"');
  });

  it('prefers the matched line over the start-a-match link, and escapes company names and the hint URL', () => {
    const one = (donation: MemberPortalData['donations'][number]) => givingDoorView(data({ donors: [donor('donor-1', 'Jane Donor', { donations: [donation] })] }), 'en');
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
    const html = givingDoorView(data({ funraise: { manageRecurringUrl: null, renewMembershipUrl: 'https://example.funraise.org/give' } }), 'es');
    expect(html).toContain(t('es', 'portal.renewMembershipLink'));
    expect(html).not.toContain(t('es', 'portal.manageRecurringLink'));
    expect(html).toContain(t('es', 'portal.givingLinksNote'));
  });
});
