import { describe, it, expect } from 'vitest';
import { checkEmailView, errorView, loginFormView, page, portalView } from './views';
import type { PortalView } from './types';
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
});

describe('loginFormView', () => {
  it('renders a form posting to /login with an email field and a language picker', () => {
    const html = loginFormView('en');
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="email"');
    expect(html).toContain('Send login link');
    // one option per supported locale, each linking through /lang/:code
    expect(html).toContain('/lang/es');
    expect(html).toContain('/lang/vi');
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

  it('renders each donor under its own name header, never a single merged view', () => {
    const html = portalView(data, 'en');
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
    const html = portalView(maliciousData, 'en');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('links each donor to their own membership card, locale-prefixed', () => {
    const html = portalView(data, 'es');
    expect(html).toContain('/es/portal/card/donor-1');
    expect(html).toContain('/es/portal/card/donor-2');
  });

  it('links tax documents and change-request under the same locale prefix', () => {
    const html = portalView(data, 'vi');
    expect(html).toContain('href="/vi/portal/letters"');
    expect(html).toContain('href="/vi/portal/change-request"');
  });

  it('includes a language switcher offering every supported locale', () => {
    const html = portalView(data, 'en');
    expect(html).toContain('/lang/es?to=%2Fen%2Fportal');
    expect(html).toContain('/lang/vi?to=%2Fen%2Fportal');
  });

  it('includes a per-language "make this my language" form posting field=language to the change-request endpoint', () => {
    const html = portalView(data, 'en');
    expect(html).toContain('action="/en/portal/change-request"');
    expect(html).toContain('value="language"');
    expect(html).toContain('value="Spanish"'); // the es option's newValue is the Monday label, not "es"
  });

  it('renders actual translated copy for a non-English locale, not just structure', () => {
    const html = portalView(data, 'es');
    expect(html).toContain(t('es', 'portal.heading'));
  });

  it('omits the volunteer section entirely when the feature is disabled (volunteerHistory null)', () => {
    const html = portalView(data, 'en');
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
    const html = portalView(withVolunteers, 'en');
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
    const html = portalView(withMaliciousShift, 'en');
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
    const html = portalView(withVolunteers, 'es');
    expect(html).toContain(t('es', 'portal.volunteerHeading'));
    expect(html).toContain(t('es', 'portal.volunteerTotalHours', { hours: '3.5' }));
  });
});
