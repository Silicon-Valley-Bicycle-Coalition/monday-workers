import { describe, it, expect } from 'vitest';
import { homeView } from './homeView';
import type { HomeData, DoorLink } from './loadHomeData';
import type { HomePerson, PersonState } from './homeState';
import { membershipEnded, pageState } from './homeState';
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

// The loader's "today" for these fixtures.
const TODAY = '2027-01-10';

function data(entries: { person: HomePerson; state: PersonState; card?: PortalCard | null }[], overrides: Partial<HomeData> = {}): HomeData {
  const people = entries.map((e) => ({
    person: e.person,
    state: e.state,
    card: e.card === undefined ? card(e.person.id, `${e.person.firstName} Rivera`) : e.card,
    ended: membershipEnded(e.person, TODAY),
  }));
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

  // A letter whose only gifts are separately listed (donor-advised fund) acknowledges nothing and
  // shows no total, so the home page doesn't claim "0 gifts · $0.00".
  it('tax letter with no acknowledged gifts: no gift line', () => {
    const dafOnly = { year: 2026, giftCount: 0, totalFormatted: '$0.00' };
    const html = homeView(data([{ person: person('j', 'Jordan', { letter: dafOnly }), state: { kind: 'taxLetter', letter: dafOnly } }]), 'en', RENEW);
    expect(html).toContain('Your 2026 tax letter is ready.');
    expect(html).not.toContain('0 gifts');
    expect(html).not.toContain('$0.00');
    expect(html).not.toContain('class="home-sub"');
    expect(goldHref(html)).toBe('/en/portal/letters');
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

  it('an Active membership past its Member Until reads ended, with the year, on a greyed card', () => {
    const html = homeView(
      data([{ person: person('j', 'Jordan', { status: 'Active', until: '2026-10-31' }), state: { kind: 'renew', reason: 'lapsed', date: '2026-10-31' } }]),
      'en',
      RENEW
    );
    expect(html).toContain('Your membership ended Oct 31, 2026.');
    expect(html).toContain('member-card-lapsed');
    expect(html).toMatch(/Ended<\/span><span class="value">10\/2026</);
  });

  it('greys an ended card even while the tax letter holds the page', () => {
    const html = homeView(
      data([{ person: person('j', 'Jordan', { status: 'Active', until: '2026-10-31', letter }), state: { kind: 'taxLetter', letter } }]),
      'en',
      RENEW
    );
    expect(html).toContain('member-card-lapsed');
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

  it('two new members: the headline agrees with several names (Spanish plural)', () => {
    const html = homeView(
      data([
        { person: person('j', 'Jordan', { memberType: 'New' }), state: { kind: 'newMember' } },
        { person: person('s', 'Sam', { memberType: 'New' }), state: { kind: 'newMember' } },
      ]),
      'es',
      RENEW
    );
    expect(html).toContain('Jordan y Sam se unieron a SVBC.');
  });

  it('one new member in a household: the headline stays singular', () => {
    const html = homeView(
      data([
        { person: person('j', 'Jordan', { memberType: 'New' }), state: { kind: 'newMember' } },
        { person: person('s', 'Sam'), state: { kind: 'default' } },
      ]),
      'es',
      RENEW
    );
    expect(html).toContain('Jordan se unió a SVBC.');
  });

  it('a household where no one is a member yet gets join wording, not renew', () => {
    const never: PersonState = { kind: 'renew', reason: 'never', date: null };
    const blank = { status: '', tier: '', until: '' };
    const html = homeView(
      data([
        { person: person('j', 'Jordan', blank), state: never, card: null },
        { person: person('s', 'Sam', blank), state: never, card: null },
      ]),
      'en',
      RENEW
    );
    expect(html).toContain('Not members yet: Jordan and Sam.');
    expect(goldText(html)).toBe(t('en', 'home.joinAny'));
    expect(html).toContain(t('en', 'home.joinSub'));
    expect(html).toContain(t('en', 'home.joinEachNote').replace(/'/g, '&#39;'));
    expect(html).not.toContain('Renew');
    expect(html).not.toContain('renew');
  });

  it('one never-member in a household (the other loaded failed) still gets join wording', () => {
    const html = homeView(
      data([{ person: person('j', 'Jordan', { status: '', tier: '', until: '' }), state: { kind: 'renew', reason: 'never', date: null }, card: null }], { unavailableCount: 1 }),
      'en',
      RENEW
    );
    expect(html).toContain('Jordan isn&#39;t a member yet.');
    expect(goldText(html)).toBe(t('en', 'home.joinAny'));
    expect(html).not.toContain('Renew');
  });

  it('default: a household says "Your member cards", with one record missing too', () => {
    const html = homeView(data([{ person: jordan, state: { kind: 'default' } }], { unavailableCount: 1 }), 'en', RENEW);
    expect(html).toContain(`<h1 class="home-headline">${t('en', 'home.defaultHeadlineMany')}</h1>`);
  });

  it('default with no card to show: no "member card" headline', () => {
    const html = homeView(
      data([
        { person: jordan, state: { kind: 'default' }, card: null },
        { person: person('s', 'Sam'), state: { kind: 'default' }, card: null },
      ]),
      'en',
      RENEW
    );
    expect(html).toContain(`<h1 class="home-headline">${t('en', 'home.defaultHeadlineNoCard')}</h1>`);
    expect(html).not.toContain('member card');
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

  it("separates each door's title from its hint for screen readers", () => {
    const html = homeView(data([{ person: person('j', 'Jordan'), state: { kind: 'default' } }]), 'en', RENEW);
    expect(html).toContain('<span class="home-door-title">Card &amp; discounts<span class="visually-hidden">: </span></span><span class="home-door-hint">');
  });

  it('renders only the doors it is given', () => {
    const html = homeView(data([{ person: person('j', 'Jordan'), state: { kind: 'default' } }], { doors: DOORS.filter((d) => d.key !== 'letters') }), 'en', RENEW);
    expect(html).not.toContain('/en/portal/letters');
  });
});

function escapeAmp(url: string): string {
  return url.replace(/&/g, '&amp;');
}
