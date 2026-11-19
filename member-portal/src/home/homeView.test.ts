import { describe, it, expect } from 'vitest';
import { homeView } from './homeView';
import type { HomeData, DoorLink } from './loadHomeData';
import type { HomePerson, PersonState } from './homeState';
import { pageState } from './homeState';
import type { PortalCard } from '../card/loadCardData';
import { t } from '../i18n/t';

const RENEW = 'https://example.funraise.org/give?campaign=membership';

function person(id: string, firstName: string, overrides: Partial<HomePerson> = {}): HomePerson {
  return { id, firstName, status: 'Active', tier: 'Member', until: '2027-11-30', since: '', memberType: '', letter: null, ...overrides };
}

function card(id: string, name: string): PortalCard {
  return {
    data: { donorId: id, donorName: name, memberNumber: `Member #${id}`, membershipTier: 'Member', membershipStatus: 'Active', expiryDisplay: '', expiryShort: 'Nov 2027' },
    qrSvg: '<svg></svg>',
  };
}

const DOORS: DoorLink[] = [
  { key: 'card', href: '/en/portal/card', hint: '14 shops · keep it on your phone' },
  { key: 'giving', href: '/en/portal/giving', hint: 'History, recurring gifts, employer match' },
  { key: 'letters', href: '/en/portal/letters', hint: '2027 ready in January' },
  { key: 'activity', href: '/en/portal/activity', hint: 'Your sign-ups and hours' },
  { key: 'info', href: '/en/portal/info', hint: 'Address, language, what we send' },
];

function data(entries: { person: HomePerson; state: PersonState; card?: PortalCard | null }[], overrides: Partial<HomeData> = {}): HomeData {
  const people = entries.map((e) => ({ person: e.person, state: e.state, card: e.card === undefined ? card(e.person.id, `${e.person.firstName} Rivera`) : e.card }));
  return { people, discountCount: 14, page: pageState(people), unavailableCount: 0, doors: DOORS, ...overrides };
}

const goldCount = (html: string) => (html.match(/class="cta-button/g) ?? []).length;
// The href of the one gold button.
const goldHref = (html: string) => /<a class="cta-button[^"]*" href="([^"]*)"/.exec(html)?.[1];
const goldText = (html: string) => /<a class="cta-button[^>]*>([^<]*)<\/a>/.exec(html)?.[1];

const letter = { year: 2026, giftCount: 3, totalFormatted: '$250.00' };

describe('homeView — one person', () => {
  it('tax letter: headline, gift line and a gold button to the letters door', () => {
    const html = homeView(data([{ person: person('j', 'Jordan', { letter }), state: { kind: 'taxLetter', letter } }]), 'en', RENEW);
    expect(html).toContain('Your 2026 tax letter is ready.');
    expect(html).toContain('3 gifts · $250.00 in 2026');
    expect(goldCount(html)).toBe(1);
    expect(goldHref(html)).toBe('/en/portal/letters');
    expect(goldText(html)).toBe('Get your tax letter');
  });

  it('renewal due: headline with the date and a gold renew button', () => {
    const html = homeView(data([{ person: person('j', 'Jordan', { until: '2027-02-01' }), state: { kind: 'renew', reason: 'due', date: '2027-02-01' } }]), 'en', RENEW);
    expect(html).toContain('Your membership ends Feb 1.');
    expect(html).toContain('Renew to keep your shop discounts.');
    expect(goldCount(html)).toBe(1);
    expect(goldHref(html)).toBe(escapeAmp(RENEW));
    expect(goldText(html)).toBe('Renew your membership');
  });

  it('lapsed: greyed card that reads Ended MM/YYYY', () => {
    const html = homeView(
      data([{ person: person('j', 'Jordan', { status: 'Lapsed', until: '2026-10-31' }), state: { kind: 'renew', reason: 'lapsed', date: '2026-10-31' } }]),
      'en',
      RENEW
    );
    expect(html).toContain('Your membership ended Oct 31, 2026.');
    expect(html).toContain('member-card-lapsed');
    expect(html).toMatch(/Ended<\/span><span class="value">10\/2026</);
    expect(goldCount(html)).toBe(1);
  });

  it('new member: names the shop count, gold button to the card door', () => {
    const html = homeView(data([{ person: person('j', 'Jordan', { memberType: 'New' }), state: { kind: 'newMember' } }]), 'en', RENEW);
    expect(html).toContain('Welcome, Jordan');
    expect(html).toContain("You're a member.".replace("'", '&#39;'));
    expect(html).toContain('Show your card at 14 local bike shops for member discounts.');
    expect(goldCount(html)).toBe(1);
    expect(goldHref(html)).toBe('/en/portal/card');
  });

  it('new member without a shop count leaves the number out', () => {
    const html = homeView(data([{ person: person('j', 'Jordan', { memberType: 'New' }), state: { kind: 'newMember' } }], { discountCount: null }), 'en', RENEW);
    expect(html).toContain('Show your card at local bike shops for member discounts.');
    expect(html).not.toMatch(/at \d+ local/);
  });

  it('default: "Your member card" and no gold button', () => {
    const html = homeView(data([{ person: person('j', 'Jordan'), state: { kind: 'default' } }]), 'en', RENEW);
    expect(html).toContain('Hi Jordan');
    expect(html).toContain('Your member card');
    expect(goldCount(html)).toBe(0);
    expect(html).toContain('class="member-card"');
    // The home page's card has no regenerate form (that lives on the card door).
    expect(html).not.toContain('/regenerate');
  });

  it('never a member: "Become a member", a Join button and a panel instead of a card', () => {
    const html = homeView(
      data([{ person: person('j', 'Jordan', { status: '', tier: '', until: '' }), state: { kind: 'renew', reason: 'never', date: null }, card: null }]),
      'en',
      RENEW
    );
    expect(html).toContain('Become a member');
    expect(goldText(html)).toBe('Join');
    expect(goldHref(html)).toBe(escapeAmp(RENEW));
    expect(html).toContain('Not a member yet');
    expect(html).not.toContain('class="member-card');
  });
});

describe('homeView — household', () => {
  const jordan = person('j', 'Jordan');

  it('greets both, and a lapsed Sam names Sam but the button renews "a membership"', () => {
    const sam = person('s', 'Sam', { status: 'Lapsed', until: '2026-10-31' });
    const html = homeView(
      data([
        { person: jordan, state: { kind: 'default' } },
        { person: sam, state: { kind: 'renew', reason: 'lapsed', date: '2026-10-31' } },
      ]),
      'en',
      RENEW
    );
    expect(html).toContain('Hi Jordan and Sam');
    expect(html).toContain('Sam&#39;s membership ended Oct 31, 2026.');
    expect(goldCount(html)).toBe(1);
    expect(goldText(html)).toBe(t('en', 'home.renewAny'));
    expect(goldText(html)).toBe('Renew a membership');
    expect(html).toContain(t('en', 'home.renewEachNote').replace(/'/g, '&#39;'));
  });

  it('both with tax letters: "Get your tax letters", no single gift line', () => {
    const html = homeView(
      data([
        { person: person('j', 'Jordan', { letter }), state: { kind: 'taxLetter', letter } },
        { person: person('s', 'Sam', { letter }), state: { kind: 'taxLetter', letter } },
      ]),
      'en',
      RENEW
    );
    expect(goldText(html)).toBe('Get your tax letters');
    expect(goldHref(html)).toBe('/en/portal/letters');
    expect(html).not.toContain('3 gifts');
  });

  it("Jordan's tax letter wins the gold button; lapsed Sam's card carries a plain Renew link", () => {
    const sam = person('s', 'Sam', { status: 'Lapsed', until: '2026-10-31' });
    const html = homeView(
      data([
        { person: person('j', 'Jordan', { letter }), state: { kind: 'taxLetter', letter } },
        { person: sam, state: { kind: 'renew', reason: 'lapsed', date: '2026-10-31' } },
      ]),
      'en',
      RENEW
    );
    expect(goldCount(html)).toBe(1);
    expect(goldText(html)).toBe('Get Jordan&#39;s tax letter');
    expect(html).toContain('3 gifts · $250.00 in 2026');
    expect(html).toContain(`<a class="home-person-action" href="${escapeAmp(RENEW)}" rel="noopener noreferrer">Renew</a>`);
  });

  // Review Focus #3: the viewer may be the person who failed to load, so the copy stays a household's.
  it('treats a household with one record missing as a household', () => {
    const sam = person('s', 'Sam', { status: 'Lapsed', until: '2026-10-31' });
    const html = homeView(data([{ person: sam, state: { kind: 'renew', reason: 'lapsed', date: '2026-10-31' } }], { unavailableCount: 1 }), 'en', RENEW);
    expect(html).toContain('Sam&#39;s membership ended Oct 31, 2026.');
    expect(goldCount(html)).toBe(1);
    expect(goldText(html)).toBe('Renew a membership');
    expect(html).toContain(t('en', 'home.renewEachNote').replace(/'/g, '&#39;'));
  });

  it('names whose tax letter it is when one household record is missing', () => {
    const html = homeView(data([{ person: person('j', 'Jordan', { letter }), state: { kind: 'taxLetter', letter } }], { unavailableCount: 1 }), 'en', RENEW);
    expect(html).toContain('Jordan&#39;s 2026 tax letter is ready.');
    expect(goldText(html)).toBe('Get Jordan&#39;s tax letter');
  });

  it('shows the unavailable note when a record failed to load', () => {
    const html = homeView(data([{ person: jordan, state: { kind: 'default' } }], { unavailableCount: 1 }), 'en', RENEW);
    expect(html).toContain(t('en', 'portal.someRecordsUnavailable'));
  });
});

describe('homeView — doors', () => {
  it('renders each door in order with its title and hint', () => {
    const html = homeView(data([{ person: person('j', 'Jordan'), state: { kind: 'default' } }]), 'en', RENEW);
    const hrefs = [...html.matchAll(/<a class="home-door" href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(DOORS.map((d) => d.href));
    expect(html).toContain('Card &amp; discounts');
    expect(html).toContain('14 shops · keep it on your phone');
  });

  it('renders only the doors it is given', () => {
    const html = homeView(data([{ person: person('j', 'Jordan'), state: { kind: 'default' } }], { doors: DOORS.filter((d) => d.key !== 'letters') }), 'en', RENEW);
    expect(html).not.toContain('/en/portal/letters');
  });
});

function escapeAmp(url: string): string {
  return url.replace(/&/g, '&amp;');
}
