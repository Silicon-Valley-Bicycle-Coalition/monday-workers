import { describe, it, expect } from 'vitest';
import { checkEmailView, errorView, loginFormView, page, portalView } from './views';
import type { FunraiseLinkUrls, PortalView } from './types';
import type { PortalCard } from './card/loadCardData';
import { t } from './i18n/t';

describe('page', () => {
  it('wraps the body in a document with charset, viewport, the given title, and the locale as <html lang>', () => {
    const html = page('Check Your Email — SVBC Member Portal', '<h1>Check your email</h1>', 'es');
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<title>Check Your Email — SVBC Member Portal</title>');
    expect(html).toContain('<h1>Check your email</h1>');
  });

  it('escapes a title containing markup', () => {
    const html = page('<script>alert(1)</script>', '<p>body</p>', 'en');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders the shared site header with the SVBC wordmark on every page', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-header"');
    expect(html).toContain('class="site-logo"');
  });

  it('omits the logout button by default (pre-identity and public pages)', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).not.toContain('action="/logout"');
  });

  it('shows a logout button in the header when authenticated', () => {
    const html = page('Title', '<p>body</p>', 'en', { authenticated: true });
    expect(html).toContain('action="/logout"');
    expect(html).toContain(t('en', 'portal.logout'));
  });

  it('links the header logo to the org website, opening in a new tab', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-header-logo-link" href="https://bikesiliconvalley.org" target="_blank"');
  });

  it('shows a gold Donate button in the header linking to the ways-to-give page', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-header-donate" href="https://bikesiliconvalley.org/ways-to-give"');
    expect(html).toContain(t('en', 'nav.donate'));
  });

  it('renders a footer with basic org contact information, on every page', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-footer"');
    expect(html).toContain('Silicon Valley Bicycle Coalition');
    expect(html).toContain('95 S Market St, Suite 648, San José, CA 95113');
    expect(html).toContain('href="https://bikesiliconvalley.org"');
  });

  it('renders the org\'s nonprofit status, EIN, and mailing address in the footer', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain(t('en', 'footer.nonprofit'));
    expect(html).toContain('77-0338658');
    expect(html).toContain(t('en', 'footer.mailingAddress'));
    expect(html).toContain('PO Box 1927, San José, CA 95109');
  });

  it('links to the privacy policy in the footer, opening in a new tab', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain(
      'href="https://siliconvalleybicyclecoaliti.app.box.com/s/1diyqeoe5dcsfsg0qx2yk7oa539toz35" target="_blank"'
    );
    expect(html).toContain(t('en', 'footer.privacyPolicy'));
  });

  it('renders a footer language switcher offering every supported locale, auto-submitting on change', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('class="site-footer-lang" action="/lang" method="get"');
    expect(html).toContain('<option value="es">');
    expect(html).toContain('<option value="vi">');
    expect(html).toContain('<option value="en" selected>');
    // Auto-submits on select, filling `to` with the browser's actual current path so switching
    // language returns the visitor to wherever they were, without page() needing to know it.
    expect(html).toContain(`onchange="this.form.to.value = location.pathname; this.form.submit()"`);
  });

  // Distinct from LOCALE_LABELS (the English names round-tripped through Monday's Preferred
  // Language column) — this picker shows each language's own name, so a visitor recognizes
  // theirs even while the page is rendered in a language they don't read.
  it('labels each language option in its own language, not English', () => {
    const html = page('Title', '<p>body</p>', 'en');
    expect(html).toContain('<option value="es">Español</option>');
    expect(html).toContain('<option value="ja">日本語</option>');
    expect(html).toContain('<option value="vi">Tiếng Việt</option>');
    expect(html).not.toContain('>Spanish<');
    expect(html).not.toContain('>Japanese<');
  });
});

describe('loginFormView', () => {
  it('renders an H1 with just "Member Portal", not the full SVBC-prefixed site title', () => {
    const html = loginFormView('en');
    expect(html).toContain('<h1>Member Portal</h1>');
  });

  it('renders a form posting to / with an email field', () => {
    const html = loginFormView('en');
    expect(html).toContain('action="/"');
    expect(html).toContain('name="email"');
    expect(html).toContain('Send login link');
  });

  it('renders the prompt in the requested locale when translated (fallback to English otherwise)', () => {
    const html = loginFormView('en');
    expect(html).toContain('Enter your email to receive a login link.');
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = loginFormView('es');
    expect(html).toContain(t('es', 'login.prompt'));
  });
});

describe('checkEmailView', () => {
  it('renders the same generic message regardless of caller state', () => {
    const html = checkEmailView('en');
    expect(html).toContain('check your email');
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = checkEmailView('es');
    expect(html).toContain(t('es', 'checkEmail.heading'));
  });
});

describe('errorView', () => {
  it('renders the message for the given translation key, escaped', () => {
    const html = errorView('error.invalidLink', 'en');
    expect(html).toContain('This link is invalid');
  });

  it('links back to / for a new link', () => {
    const html = errorView('error.invalidLink', 'en');
    expect(html).toContain('href="/"');
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = errorView('error.invalidLink', 'es');
    expect(html).toContain(t('es', 'error.invalidLink'));
  });
});

describe('portalView', () => {
  const data: PortalView = {
    donors: [
      {
        id: 'donor-1',
        name: 'Jane Donor',
        membershipStatus: 'Active',
        membershipTier: 'Member',
        totalDonated: '500',
        donations: [{ date: '2026-01-01', amount: '100', description: 'Annual gift' }],
        membershipExpiry: '',
      },
      {
        id: 'donor-2',
        name: 'Jane Also',
        membershipStatus: 'Active',
        membershipTier: 'Lifetime',
        totalDonated: '2500',
        donations: [],
        membershipExpiry: '',
      },
    ],
    discounts: [{ name: 'Local Bikes', discountOffered: '10% off' }],
    donationHistoryEnabled: true,
    volunteerHistory: null,
  };

  const noFunraise: FunraiseLinkUrls = { manageRecurringUrl: null, renewMembershipUrl: null };
  const bothFunraise: FunraiseLinkUrls = {
    manageRecurringUrl: 'https://example.funraise.org/account',
    renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership&a=1',
  };

  it('tells the donor when some of their records could not be loaded', () => {
    const html = portalView({ ...data, unavailableDonorCount: 1 }, 'en', {}, noFunraise);
    expect(html).toContain(t('en', 'portal.someRecordsUnavailable'));
    expect(portalView(data, 'en', {}, noFunraise)).not.toContain(t('en', 'portal.someRecordsUnavailable'));
  });

  it('omits the discounts section when the discount list failed to load', () => {
    const html = portalView({ ...data, discounts: null }, 'en', {}, noFunraise);
    expect(html).not.toContain(t('en', 'portal.discountsHeading'));
  });

  it('omits the Donations tab and every gift figure while donation history is gated off', () => {
    const hidden: PortalView = { ...data, donationHistoryEnabled: false };
    const html = portalView(hidden, 'en', {}, noFunraise);
    expect(html).not.toContain(t('en', 'portal.donationsTabLabel'));
    expect(html).not.toContain('$100.00');
    expect(html).not.toContain('$500.00');
    expect(html).not.toContain(t('en', 'portal.totalLabel'));
    expect(html).not.toContain(t('en', 'portal.donateButton'));
    // The donor section itself still renders: name and membership line.
    expect(html).toContain('Jane Donor');
    expect(html).toContain(t('en', 'portal.membership', { status: 'Active', tier: 'Member' }));
  });

  it('formats donation amounts and the running total as US currency', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).toContain('$100.00'); // donation row, from data.donors[0]
    expect(html).toContain('$500.00'); // totalDonated: '500' -> $500.00
    expect(html).toContain('$2,500.00'); // totalDonated: '2500' -> thousands separator
  });

  it('formats donation dates as "Mon D, YYYY" instead of the raw ISO date', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).toContain('Jan 1, 2026'); // date: '2026-01-01', from data.donors[0]'s donation
    expect(html).not.toContain('2026-01-01');
  });

  it('right-aligns the Amount column header and cells', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).toContain('<th class="col-amount">');
    expect(html).toContain('<td class="col-amount">');
  });

  it('shows the running total as a table footer row, not a standalone paragraph', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).toContain('<tfoot>');
    expect(html).toContain('Total donated');
    expect(html).not.toContain('<p>Total donated');
  });

  it('renders each donor under its own name header, never a single merged view', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).toContain('Jane Donor');
    expect(html).toContain('Jane Also');
    expect(html).toContain('Annual gift');
    expect(html).toContain('Local Bikes');
  });

  it('escapes donor-sourced text instead of rendering it raw', () => {
    const maliciousData: PortalView = {
      donors: [
        {
          id: 'donor-3',
          name: '<img src=x onerror=alert(1)>',
          membershipStatus: 'Active',
          membershipTier: 'Member',
          totalDonated: '0',
          donations: [],
          membershipExpiry: '',
        },
      ],
      discounts: [],
      donationHistoryEnabled: true,
      volunteerHistory: null,
    };
    const html = portalView(maliciousData, 'en', {}, noFunraise);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('renders the wallet card widget inline for a donor with card data, and points regenerate at their own route', () => {
    const cards: Record<string, PortalCard> = {
      'donor-1': {
        data: {
          donorId: 'donor-1',
          donorName: 'Jane Donor',
          memberNumber: 'Member #donor-1',
          membershipTier: 'Gold',
          membershipStatus: 'Active',
          expiryDisplay: 'June 30, 2027',
          expiryShort: 'Jun 2027',
        },
        qrSvg: '<svg data-testid="qr"></svg>',
      },
    };
    const html = portalView(data, 'es', cards, noFunraise);
    expect(html).toContain('class="member-card"');
    expect(html).toContain('Member #donor-1');
    expect(html).toContain('Jun 2027');
    expect(html).toContain('Gold');
    expect(html).toContain('<svg data-testid="qr"></svg>');
    expect(html).toContain('action="/es/portal/card/donor-1/regenerate"');
    expect(html).not.toContain('June 30, 2027'); // the long form is verify-page-only, not on the card
  });

  it('never shows the QR target URL as visible text', () => {
    const cards: Record<string, PortalCard> = {
      'donor-1': {
        data: {
          donorId: 'donor-1',
          donorName: 'Jane Donor',
          memberNumber: 'Member #donor-1',
          membershipTier: 'Gold',
          membershipStatus: 'Active',
          expiryDisplay: 'June 30, 2027',
          expiryShort: 'Jun 2027',
        },
        qrSvg: '<svg data-testid="qr"></svg>',
      },
    };
    const html = portalView(data, 'en', cards, noFunraise);
    expect(html).not.toContain('https://member.bikesiliconvalley.org/verify/');
    expect(html).not.toContain('/verify/');
  });

  it('omits the card widget for a donor with no card data (e.g. cardEnabled is false, or token issuance failed)', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).not.toContain('class="member-card"');
    expect(html).not.toContain('/regenerate"');
  });

  it('links tax documents and change-request under the same locale prefix', () => {
    const html = portalView(data, 'vi', {}, noFunraise);
    expect(html).toContain('href="/vi/portal/letters"');
    expect(html).toContain('href="/vi/portal/change-request"');
  });

  it('does not offer a per-language change-request button (superseded by the general "Request a change" form\'s Language field)', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).not.toContain('action="/en/portal/change-request"');
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = portalView(data, 'es', {}, noFunraise);
    expect(html).toContain(t('es', 'portal.heading'));
  });

  it('omits the volunteer tab entirely when the feature is disabled (volunteerHistory null)', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).not.toContain(t('en', 'portal.volunteerHeading'));
  });

  it('renders a Volunteer tab with real data for a donor with shifts, and a CTA for one without', () => {
    const withVolunteers: PortalView = {
      ...data,
      volunteerHistory: {
        'donor-1': {
          shifts: [
            { date: '2026-03-05', hours: '3.5', job: 'Bike Valet', status: 'Completed' },
            { date: '2026-01-10', hours: '2', job: 'Tabling', status: 'Completed' },
          ],
          totalHours: 5.5,
        },
        'donor-2': { shifts: [], totalHours: 0 },
      },
    };
    const html = portalView(withVolunteers, 'en', {}, noFunraise);
    // Both donors now get a Volunteer tab (feature is enabled) — donor-1's has real data,
    // donor-2's is empty, so the tab label itself appears once per donor.
    expect(html.split(t('en', 'portal.volunteerHeading')).length - 1).toBe(2);
    expect(html).toContain('Bike Valet');
    expect(html).toContain('Total volunteer hours: 5.5');
  });

  it('shows the volunteer CTA, not an empty table, for a donor with the feature enabled but no shifts', () => {
    const withVolunteers: PortalView = {
      ...data,
      volunteerHistory: {
        'donor-1': { shifts: [{ date: '2026-03-05', hours: '3.5', job: 'Bike Valet', status: 'Completed' }], totalHours: 3.5 },
        'donor-2': { shifts: [], totalHours: 0 },
      },
    };
    const html = portalView(withVolunteers, 'en', {}, noFunraise);
    expect(html).toContain(t('en', 'portal.volunteerEmptyMessage'));
    expect(html).toContain(t('en', 'portal.volunteerButton'));
    expect(html).toContain('href="https://bikesiliconvalley.org/get-involved/volunteer"');
  });

  it('escapes volunteer-shift text instead of rendering it raw', () => {
    const withMaliciousShift: PortalView = {
      ...data,
      volunteerHistory: {
        'donor-1': {
          shifts: [{ date: '2026-03-05', hours: '1', job: '<script>alert(1)</script>', status: 'Completed' }],
          totalHours: 1,
        },
      },
    };
    const html = portalView(withMaliciousShift, 'en', {}, noFunraise);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders translated volunteer copy for a non-English locale', () => {
    const withVolunteers: PortalView = {
      ...data,
      volunteerHistory: {
        'donor-1': {
          shifts: [{ date: '2026-03-05', hours: '3.5', job: 'Bike Valet', status: 'Completed' }],
          totalHours: 3.5,
        },
      },
    };
    const html = portalView(withVolunteers, 'es', {}, noFunraise);
    expect(html).toContain(t('es', 'portal.volunteerHeading'));
    expect(html).toContain(t('es', 'portal.volunteerTotalHours', { hours: '3.5' }));
  });

  it('shows a Donate CTA instead of an empty table for a donor with no donations and nothing on file', () => {
    const noDonations: PortalView = {
      donors: [
        {
          id: 'donor-3',
          name: 'New Donor',
          membershipStatus: 'Active',
          membershipTier: 'Member',
          totalDonated: '0',
          donations: [],
          membershipExpiry: '',
        },
      ],
      discounts: [],
      donationHistoryEnabled: true,
      volunteerHistory: null,
    };
    const html = portalView(noDonations, 'en', {}, noFunraise);
    expect(html).toContain(t('en', 'portal.donationsEmptyMessage'));
    expect(html).toContain(t('en', 'portal.donateButton'));
    expect(html).toContain('href="https://bikesiliconvalley.org/ways-to-give"');
    expect(html).not.toContain('<tfoot>');
  });

  it('still shows the donations table and running total when totalDonated is nonzero, even with no itemized rows on file', () => {
    // donor-2 has totalDonated: '2500' but donations: [] — a real rollup with no itemized rows
    // (e.g. older gifts never synced as line items), not a donor who's never given.
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).toContain('$2,500.00');
    expect(html).not.toContain(t('en', 'portal.donationsEmptyMessage'));
  });
});

describe('portalView impact summary', () => {
  const noFunraise: FunraiseLinkUrls = { manageRecurringUrl: null, renewMembershipUrl: null };
  const donor = (id: string, name: string) => ({
    id,
    name,
    membershipStatus: 'Active',
    membershipTier: 'Member',
    totalDonated: '100',
    donations: [{ date: '2026-01-01', amount: '100', description: 'Annual gift' }],
    membershipExpiry: '',
  });
  const base: PortalView = {
    donors: [donor('donor-1', 'Jane Donor'), donor('donor-2', 'Jane Also')],
    discounts: [],
    donationHistoryEnabled: true,
    volunteerHistory: null,
  };

  it('renders no impact heading when no donor has an impact summary', () => {
    const html = portalView(base, 'en', {}, noFunraise);
    expect(html).not.toContain(t('en', 'portal.impactHeading', { year: '2026' }));
  });

  it('renders the year heading and one list item per statement', () => {
    const impact = { 'donor-1': { year: '2026', statements: ['First statement', 'Second statement'] } };
    const html = portalView(base, 'en', {}, noFunraise, null, impact);
    expect(html).toContain(t('en', 'portal.impactHeading', { year: '2026' }));
    expect(html).toContain('<li>First statement</li>');
    expect(html).toContain('<li>Second statement</li>');
  });

  it("renders a donor's impact inside that donor's section only", () => {
    const impact = { 'donor-2': { year: '2026', statements: ['Only for the second donor'] } };
    const html = portalView(base, 'en', {}, noFunraise, null, impact);
    const firstSection = html.slice(html.indexOf('Jane Donor'), html.indexOf('Jane Also'));
    const secondSection = html.slice(html.indexOf('Jane Also'));
    expect(firstSection).not.toContain('Only for the second donor');
    expect(secondSection).toContain('<li>Only for the second donor</li>');
  });

  it('escapes HTML in a statement', () => {
    const impact = { 'donor-1': { year: '2026', statements: ['<script>alert(1)</script>'] } };
    const html = portalView(base, 'en', {}, noFunraise, null, impact);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('portalView events tab', () => {
  const base: PortalView = {
    donors: [
      {
        id: 'donor-1',
        name: 'Jane Donor',
        membershipStatus: 'Active',
        membershipTier: 'Member',
        totalDonated: '500',
        donations: [{ date: '2026-01-01', amount: '100', description: 'Annual gift' }],
        membershipExpiry: '',
      },
    ],
    discounts: [],
    donationHistoryEnabled: true,
    volunteerHistory: null,
  };
  const noFunraise: FunraiseLinkUrls = { manageRecurringUrl: null, renewMembershipUrl: null };

  it('omits the Events tab entirely when no events data is passed (feature disabled or load failed)', () => {
    const html = portalView(base, 'en', {}, noFunraise);
    expect(html).not.toContain(t('en', 'events.tabLabel'));
  });

  it('renders upcoming and past registrations when present', () => {
    const events = {
      'donor-1': {
        donorId: 'donor-1',
        donorName: 'Jane Donor',
        upcoming: [{ registrationName: 'reg-1', eventName: 'Fall Gala', eventDate: '2026-10-03', attended: false }],
        past: [{ registrationName: 'reg-2', eventName: 'Spring Ride', eventDate: '2026-03-01', attended: true }],
      },
    };
    const html = portalView(base, 'en', {}, noFunraise, events);
    expect(html).toContain(t('en', 'events.tabLabel'));
    expect(html).toContain('Fall Gala');
    expect(html).toContain('Spring Ride');
    expect(html).toContain(t('en', 'events.upcomingHeading'));
    expect(html).toContain(t('en', 'events.pastHeading'));
    expect(html).not.toContain(t('en', 'events.emptyMessage'));
  });

  it('shows a Find Upcoming Events CTA when the donor has no registrations', () => {
    const events = {
      'donor-1': { donorId: 'donor-1', donorName: 'Jane Donor', upcoming: [], past: [] },
    };
    const html = portalView(base, 'en', {}, noFunraise, events);
    expect(html).toContain(t('en', 'events.emptyMessage'));
    expect(html).toContain(t('en', 'events.findEventsButton'));
    expect(html).toContain('href="https://bikesiliconvalley.org/events"');
  });

  it('escapes event-sourced text instead of rendering it raw', () => {
    const events = {
      'donor-1': {
        donorId: 'donor-1',
        donorName: 'Jane Donor',
        upcoming: [{ registrationName: 'reg-1', eventName: '<script>alert(1)</script>', eventDate: '2026-10-03', attended: false }],
        past: [],
      },
    };
    const html = portalView(base, 'en', {}, noFunraise, events);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('portalView tab structure', () => {
  const base: PortalView = {
    donors: [
      {
        id: 'donor-1',
        name: 'Jane Donor',
        membershipStatus: 'Active',
        membershipTier: 'Member',
        totalDonated: '500',
        donations: [{ date: '2026-01-01', amount: '100', description: 'Annual gift' }],
        membershipExpiry: '',
      },
    ],
    discounts: [],
    donationHistoryEnabled: true,
    volunteerHistory: null,
  };
  const noFunraise: FunraiseLinkUrls = { manageRecurringUrl: null, renewMembershipUrl: null };

  it('keeps a Volunteer history heading when it is the only tab (donation history hidden), since no tab label names it', () => {
    const volunteerOnly: PortalView = {
      ...base,
      donationHistoryEnabled: false,
      volunteerHistory: { 'donor-1': { shifts: [{ date: '2026-02-01', job: 'Valet', hours: '2', status: 'Completed' }], totalHours: 2 } },
    };
    const html = portalView(volunteerOnly, 'en', {}, noFunraise);
    expect(html).not.toContain('class="tabs"');
    expect(html).toContain(`<h3>${t('en', 'portal.volunteerHeading')}</h3>`);
    expect(html).toContain('Valet');
  });

  it('renders donations content directly, with no tab UI, when it is the only applicable tab', () => {
    const html = portalView(base, 'en', {}, noFunraise);
    expect(html).not.toContain('class="tabs"');
    expect(html).not.toContain('type="radio"');
    expect(html).toContain('Annual gift');
  });

  it('renders a tab for each applicable section, with the first checked by default', () => {
    const withAll: PortalView = {
      ...base,
      volunteerHistory: { 'donor-1': { shifts: [{ date: '2026-03-05', hours: '1', job: 'Tabling', status: 'Completed' }], totalHours: 1 } },
    };
    const events = { 'donor-1': { donorId: 'donor-1', donorName: 'Jane Donor', upcoming: [], past: [] } };
    const html = portalView(withAll, 'en', {}, noFunraise, events);
    expect((html.match(/type="radio"/g) ?? []).length).toBe(3);
    expect((html.match(/ checked/g) ?? []).length).toBe(1);
    expect(html).toContain(t('en', 'portal.donationsTabLabel'));
    expect(html).toContain(t('en', 'portal.volunteerHeading'));
    expect(html).toContain(t('en', 'events.tabLabel'));
  });

  it("scopes each donor's tabs to their own radio group so multiple donors on one page do not collide", () => {
    const twoDonors: PortalView = {
      donors: [
        base.donors[0]!,
        {
          id: 'donor-2',
          name: 'Jane Also',
          membershipStatus: 'Active',
          membershipTier: 'Lifetime',
          totalDonated: '500',
          donations: [{ date: '2026-01-01', amount: '100', description: 'Another gift' }],
          membershipExpiry: '',
        },
      ],
      discounts: [],
      donationHistoryEnabled: true,
      volunteerHistory: {
        'donor-1': { shifts: [{ date: '2026-03-05', hours: '1', job: 'Tabling', status: 'Completed' }], totalHours: 1 },
        'donor-2': { shifts: [{ date: '2026-03-05', hours: '1', job: 'Tabling', status: 'Completed' }], totalHours: 1 },
      },
    };
    const html = portalView(twoDonors, 'en', {}, noFunraise);
    expect(html).toContain('name="tabs-donor-1"');
    expect(html).toContain('name="tabs-donor-2"');
  });
});

describe('portalView funraise deep links', () => {
  const data: PortalView = {
    donors: [
      {
        id: 'donor-1',
        name: 'Jane Donor',
        membershipStatus: 'Active',
        membershipTier: 'Member',
        totalDonated: '500',
        donations: [],
        membershipExpiry: '',
      },
    ],
    discounts: [],
    donationHistoryEnabled: true,
    volunteerHistory: null,
  };

  it('renders both Funraise links when both URLs are configured', () => {
    const html = portalView(data, 'en', {}, {
      manageRecurringUrl: 'https://example.funraise.org/account',
      renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership',
    });
    expect(html).toContain(t('en', 'portal.givingLinksHeading'));
    expect(html).toContain('href="https://example.funraise.org/account"');
    expect(html).toContain(t('en', 'portal.manageRecurringLink'));
    expect(html).toContain(t('en', 'portal.renewMembershipLink'));
    expect(html).toContain(t('en', 'portal.givingLinksNote'));
  });

  it('renders only the configured link when the other is null', () => {
    const html = portalView(data, 'en', {}, {
      manageRecurringUrl: null,
      renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership',
    });
    expect(html).toContain(t('en', 'portal.renewMembershipLink'));
    expect(html).not.toContain(t('en', 'portal.manageRecurringLink'));
  });

  it('omits the whole section when neither URL is configured', () => {
    const html = portalView(data, 'en', {}, { manageRecurringUrl: null, renewMembershipUrl: null });
    expect(html).not.toContain(t('en', 'portal.givingLinksHeading'));
    expect(html).not.toContain(t('en', 'portal.givingLinksNote'));
  });

  it('escapes URL query ampersands rather than emitting raw & in href', () => {
    const html = portalView(data, 'en', {}, {
      manageRecurringUrl: null,
      renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership&a=1',
    });
    expect(html).toContain('href="https://example.funraise.org/give?campaign=membership&amp;a=1"');
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = portalView(data, 'es', {}, {
      manageRecurringUrl: 'https://example.funraise.org/account',
      renewMembershipUrl: null,
    });
    expect(html).toContain(t('es', 'portal.manageRecurringLink'));
  });
});
