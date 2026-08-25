import { describe, it, expect } from 'vitest';
import { checkEmailView, errorView, loginFormView, page, portalView } from './views';
import type { FunraiseLinkUrls, PortalView } from './types';
import type { PortalCard } from './card/loadCardData';
import { t } from './i18n/t';

describe('page', () => {
  it('wraps the body in a document with charset, viewport, the given title, and the locale as <html lang>', () => {
    const html = page('Check Your Email — SVBC Donor Portal', '<h1>Check your email</h1>', 'es');
    expect(html).toContain('<html lang="es">');
    expect(html).toContain('<meta charset="utf-8" />');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('<title>Check Your Email — SVBC Donor Portal</title>');
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
});

describe('loginFormView', () => {
  it('renders a form posting to /login with an email field and a language picker', () => {
    const html = loginFormView('en');
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="email"');
    expect(html).toContain('Send login link');
    // a <select> submitting to GET /lang, with one <option> per supported locale
    expect(html).toContain('action="/lang"');
    expect(html).toContain('<option value="es">');
    expect(html).toContain('<option value="vi">');
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

  it('links back to /login for a new link', () => {
    const html = errorView('error.invalidLink', 'en');
    expect(html).toContain('href="/login"');
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
    volunteerHistory: null,
  };

  const noFunraise: FunraiseLinkUrls = { manageRecurringUrl: null, renewMembershipUrl: null };
  const bothFunraise: FunraiseLinkUrls = {
    manageRecurringUrl: 'https://example.funraise.org/account',
    renewMembershipUrl: 'https://example.funraise.org/give?campaign=membership&a=1',
  };

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
    expect(html).not.toContain('https://portal.bikesiliconvalley.org/verify/');
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

  it('includes a language switcher offering every supported locale, submitting to /lang', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).toContain('action="/lang"');
    expect(html).toContain('name="to" value="/en/portal"');
    expect(html).toContain('<option value="es">');
    expect(html).toContain('<option value="vi">');
    expect(html).toContain('<option value="en" selected>');
  });

  it('does not offer a per-language change-request button (superseded by the general "Request a change" form\'s Language field)', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).not.toContain('action="/en/portal/change-request"');
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = portalView(data, 'es', {}, noFunraise);
    expect(html).toContain(t('es', 'portal.heading'));
  });

  it('omits the volunteer section entirely when the feature is disabled (volunteerHistory null)', () => {
    const html = portalView(data, 'en', {}, noFunraise);
    expect(html).not.toContain(t('en', 'portal.volunteerHeading'));
  });

  it('renders a volunteer section only for donors with at least one shift', () => {
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
    expect(html).toContain(t('en', 'portal.volunteerHeading'));
    expect(html).toContain('Bike Valet');
    expect(html).toContain('Total volunteer hours: 5.5');
    // donor-2 has no shifts — exactly one volunteer section should render
    expect(html.split(t('en', 'portal.volunteerHeading')).length - 1).toBe(1);
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
