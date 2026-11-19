import { describe, it, expect, vi } from 'vitest';
import { cardDoorView, loadCardDoor, type CardDoorData, type CardDoorPerson } from './card';
import type { MondayClient } from '../monday/client';
import type { Config, MemberPortalData } from '../types';
import type { PortalCard } from '../card/loadCardData';
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

function person(id: string, name: string, overrides: Partial<CardDoorPerson> = {}): CardDoorPerson {
  return { id, name, card: card(id, name), notMember: false, lapsedEnded: null, ...overrides };
}

const discounts = [
  { name: 'Local Bikes', discountOffered: '10% off' },
  { name: 'Spoke Shop', discountOffered: '15% off parts' },
];

describe('cardDoorView', () => {
  it("shows each person's card with its QR and own regenerate form, then the discount list", () => {
    const data: CardDoorData = { people: [person('donor-1', 'Jane Donor')], discounts, unavailableCount: 0 };
    const html = cardDoorView(data, 'es');
    expect(html).toContain(t('es', 'home.doorCard'));
    expect(html).toContain('class="member-card"');
    expect(html).toContain('<svg data-testid="qr-donor-1"></svg>');
    expect(html).toContain('Member #donor-1');
    expect(html).toContain('Jun 2027');
    expect(html).toContain('action="/es/portal/card/donor-1/regenerate"');
    expect(html).not.toContain('June 30, 2027'); // the long form is verify-page-only
    expect(html).toContain(t('es', 'portal.discountsHeading'));
    expect(html).toContain('<li>Local Bikes: 10% off</li>');
    expect(html).toContain('<li>Spoke Shop: 15% off parts</li>');
    expect(html.indexOf('class="member-card"')).toBeLessThan(html.indexOf(t('es', 'portal.discountsHeading')));
  });

  it('never shows the QR target URL as visible text', () => {
    const html = cardDoorView({ people: [person('donor-1', 'Jane Donor')], discounts, unavailableCount: 0 }, 'en');
    expect(html).not.toContain('/verify/');
  });

  it('shows the cards alone when the discount list failed to load', () => {
    const html = cardDoorView({ people: [person('donor-1', 'Jane Donor')], discounts: null, unavailableCount: 0 }, 'en');
    expect(html).toContain('class="member-card"');
    expect(html).not.toContain(t('en', 'portal.discountsHeading'));
  });

  it('shows only the discount list when no one has a card (card feature off, or token failure)', () => {
    const html = cardDoorView({ people: [person('donor-1', 'Jane Donor', { card: null })], discounts, unavailableCount: 0 }, 'en');
    expect(html).not.toContain('class="member-card"');
    expect(html).not.toContain('/regenerate"');
    expect(html).toContain('<li>Local Bikes: 10% off</li>');
  });

  it('groups a household under each name, each card with its own regenerate form', () => {
    const data: CardDoorData = { people: [person('donor-1', 'Jordan Rivera'), person('donor-2', 'Sam Rivera')], discounts: [], unavailableCount: 0 };
    const html = cardDoorView(data, 'en');
    expect(html).toContain('<h2>Jordan Rivera</h2>');
    expect(html).toContain('<h2>Sam Rivera</h2>');
    expect(html).toContain('action="/en/portal/card/donor-1/regenerate"');
    expect(html).toContain('action="/en/portal/card/donor-2/regenerate"');
    const sam = html.slice(html.indexOf('<h2>Sam Rivera</h2>'));
    expect(sam).not.toContain('donor-1');
  });

  it('shows no name heading for a single person', () => {
    const html = cardDoorView({ people: [person('donor-1', 'Jane Donor')], discounts, unavailableCount: 0 }, 'en');
    expect(html).not.toContain('<h2>Jane Donor</h2>');
  });

  it('shows "Not a member yet" in place of a card for someone who never joined', () => {
    const html = cardDoorView({ people: [person('donor-1', 'Jane Donor', { card: null, notMember: true })], discounts, unavailableCount: 0 }, 'en');
    expect(html).toContain(t('en', 'home.notMember'));
    expect(html).not.toContain('class="member-card"');
  });

  it('greys out a lapsed card and shows when it ended', () => {
    const html = cardDoorView({ people: [person('donor-1', 'Jane Donor', { lapsedEnded: '10/2026' })], discounts, unavailableCount: 0 }, 'en');
    expect(html).toContain('member-card member-card-lapsed');
    expect(html).toContain('10/2026');
  });

  it('tells the member when some records could not be loaded, and still groups by name', () => {
    const html = cardDoorView({ people: [person('donor-1', 'Jane Donor')], discounts, unavailableCount: 1 }, 'en');
    expect(html).toContain(t('en', 'portal.someRecordsUnavailable'));
    expect(html).toContain('<h2>Jane Donor</h2>');
  });

  it('escapes names and discount text', () => {
    const html = cardDoorView(
      {
        people: [person('donor-1', '<img src=x onerror=alert(1)>'), person('donor-2', 'Other')],
        discounts: [{ name: '<script>x</script>', discountOffered: '<b>1</b>' }],
        unavailableCount: 0,
      },
      'en'
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('never renders the old dashboard tabs', () => {
    const html = cardDoorView({ people: [person('donor-1', 'Jane Donor')], discounts, unavailableCount: 0 }, 'en');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('class="tabs"');
  });
});

describe('loadCardDoor', () => {
  function member(id: string, overrides: Partial<MemberPortalData> = {}): MemberPortalData {
    return { id, name: `${id} Rivera`, membershipStatus: 'Active', membershipTier: 'Member', totalDonated: '$0.00', donations: [], membershipExpiry: '2027-11-30', memberSince: '', memberType: '', ...overrides };
  }

  it('reads an ended membership from the same rule as the home page, not only the Lapsed label', async () => {
    const donors: Record<string, MemberPortalData> = {
      past: member('past', { membershipExpiry: '2026-10-31' }),
      lapsed: member('lapsed', { membershipStatus: 'Lapsed', membershipExpiry: '2026-09-30' }),
      lifetime: member('lifetime', { membershipStatus: 'Lapsed', membershipTier: 'Lifetime', membershipExpiry: '2020-01-01' }),
      current: member('current'),
    };
    const monday = {
      getMemberPortalData: vi.fn(async (id: string) => donors[id]!),
      getDiscountOrganizations: vi.fn(async () => []),
    } as unknown as MondayClient;
    // Card tokens off: this test is about the ended rule only.
    const config = { monday: { columns: { membershipExpiry: 'REPLACE_WITH_COLUMN_ID' } } } as unknown as Config;
    const data = await loadCardDoor(['past', 'lapsed', 'lifetime', 'current'], {
      monday,
      config,
      now: () => new Date('2026-12-01T18:00:00Z'),
      cardTokenStore: {} as never,
    });
    expect(data.people.map((p) => p.lapsedEnded)).toEqual(['10/2026', '09/2026', null, null]);
  });

  it('treats a blank Membership Status as no membership on file, Tier or not', async () => {
    const donors: Record<string, MemberPortalData> = {
      blank: member('blank', { membershipStatus: '', membershipTier: '' }),
      tierOnly: member('tierOnly', { membershipStatus: ' ', membershipTier: 'Member' }),
      current: member('current'),
    };
    const monday = {
      getMemberPortalData: vi.fn(async (id: string) => donors[id]!),
      getDiscountOrganizations: vi.fn(async () => []),
    } as unknown as MondayClient;
    const config = { monday: { columns: { membershipExpiry: 'REPLACE_WITH_COLUMN_ID' } } } as unknown as Config;
    const data = await loadCardDoor(['blank', 'tierOnly', 'current'], {
      monday,
      config,
      now: () => new Date('2026-12-01T18:00:00Z'),
      cardTokenStore: {} as never,
    });
    expect(data.people.map((p) => p.notMember)).toEqual([true, true, false]);
  });
});
