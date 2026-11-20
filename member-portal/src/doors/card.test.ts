import { describe, it, expect } from 'vitest';
import { benefitsTabView, memberCardWidget } from './card';
import type { HomeData } from '../home/loadHomeData';
import type { PortalCard } from '../card/loadCardData';
import type { DiscountOrganization } from '../types';
import { t } from '../i18n/t';

function card(id: string, name: string): PortalCard {
  return {
    data: {
      donorId: id,
      donorName: name,
      memberNumber: `Member #${id}`,
      membershipTier: 'Gold',
      membershipStatus: 'Active',
      expiryDisplay: 'June 30, 2027',
      expiryShort: 'Jun 2027',
    },
    qrSvg: `<svg data-testid="qr-${id}"></svg>`,
  };
}

const discounts = [
  { name: 'Local Bikes', discountOffered: '10% off' },
  { name: 'Spoke Shop', discountOffered: '15% off parts' },
];

function home(people: { id: string; firstName: string; card?: PortalCard | null }[], overrides: { discounts?: DiscountOrganization[] | null; unavailableCount?: number; orgs?: HomeData['orgs'] } = {}): HomeData {
  return {
    people: people.map((p) => ({
      person: { id: p.id, firstName: p.firstName, status: 'Active', tier: 'Member', until: '2027-11-30', since: '', memberType: '', letter: null },
      state: { kind: 'default' },
      card: p.card === undefined ? card(p.id, `${p.firstName} Rivera`) : p.card,
      ended: false,
      stats: { totalDonated: null, volunteerHours: null },
    })),
    discountCount: null,
    page: { kind: 'default', personIds: [] },
    unavailableCount: overrides.unavailableCount ?? 0,
    tabs: [],
    orgs: overrides.orgs ?? [],
    portal: { donors: [], discounts: overrides.discounts === undefined ? discounts : overrides.discounts, volunteerHistory: null, donationHistoryEnabled: false },
  };
}

describe('memberCardWidget', () => {
  it('shows the QR, member number, short expiry and tier, never the QR target URL or a form', () => {
    const html = memberCardWidget(card('donor-1', 'Jane Donor'), 'en');
    expect(html).toContain('class="member-card"');
    expect(html).toContain('<svg data-testid="qr-donor-1"></svg>');
    expect(html).toContain('Member #donor-1');
    expect(html).toContain('Jun 2027');
    expect(html).not.toContain('June 30, 2027'); // the long form is verify-page-only
    expect(html).not.toContain('/verify/');
    expect(html).not.toContain('<form');
  });

  it('greys out a lapsed card and shows when it ended', () => {
    const html = memberCardWidget(card('donor-1', 'Jane Donor'), 'en', { lapsed: { ended: '10/2026' } });
    expect(html).toContain('member-card member-card-lapsed');
    expect(html).toContain('10/2026');
  });
});

describe('benefitsTabView', () => {
  it('lists the discounts first, then the card code section with a regenerate form', () => {
    const html = benefitsTabView(home([{ id: 'donor-1', firstName: 'Jane' }]), 'es');
    expect(html).toContain(`<h1 class="visually-hidden">${t('es', 'tabs.benefits')}</h1>`);
    expect(html).toContain('<section id="discounts">');
    expect(html).toContain('<li>Local Bikes: 10% off</li>');
    expect(html).toContain('<li>Spoke Shop: 15% off parts</li>');
    expect(html).toContain('action="/es/portal/card/donor-1/regenerate"');
    expect(html).toContain(t('es', 'benefits.cardIntro'));
    expect(html.indexOf('id="discounts"')).toBeLessThan(html.indexOf('/regenerate"'));
    // The card itself is in the portal header, not the tab.
    expect(html).not.toContain('class="member-card"');
  });

  it('leaves out the discount list when its read failed', () => {
    const html = benefitsTabView(home([{ id: 'donor-1', firstName: 'Jane' }], { discounts: null }), 'en');
    expect(html).not.toContain(t('en', 'portal.discountsHeading'));
    expect(html).toContain('/regenerate"');
  });

  it('shows no card code section when no one has a card', () => {
    const html = benefitsTabView(home([{ id: 'donor-1', firstName: 'Jane', card: null }]), 'en');
    expect(html).not.toContain('/regenerate"');
    expect(html).not.toContain(t('en', 'benefits.cardIntro'));
    expect(html).toContain('<li>Local Bikes: 10% off</li>');
  });

  it("names each person's regenerate form in a household", () => {
    const html = benefitsTabView(home([{ id: 'donor-1', firstName: 'Jordan' }, { id: 'donor-2', firstName: 'Sam' }]), 'en');
    expect(html).toContain(t('en', 'home.defaultHeadlineMany'));
    expect(html).toContain('<span class="card-code-name">Jordan</span><button');
    expect(html).toContain('action="/en/portal/card/donor-2/regenerate"');
  });

  it('shows the organizations the session manages', () => {
    const html = benefitsTabView(home([{ id: 'donor-1', firstName: 'Jane' }], { orgs: [{ orgItemId: 'org-1', name: 'Acme', statementReadyYear: null }] }), 'en');
    expect(html).toContain(t('en', 'orgs.sectionTitle'));
    expect(html).toContain('href="/en/portal/org/org-1"');
  });

  it('escapes names and discount text', () => {
    const html = benefitsTabView(
      home([{ id: 'donor-1', firstName: '<img src=x onerror=alert(1)>' }, { id: 'donor-2', firstName: 'Other' }], {
        discounts: [{ name: '<script>x</script>', discountOffered: '<b>1</b>' }],
      }),
      'en'
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
