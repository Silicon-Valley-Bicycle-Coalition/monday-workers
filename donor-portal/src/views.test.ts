import { describe, it, expect } from 'vitest';
import { checkEmailView, errorView, loginFormView, page, portalView } from './views';
import type { PortalView } from './types';

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
});

describe('checkEmailView', () => {
  it('renders the same generic message regardless of caller state', () => {
    const html = checkEmailView('en');
    expect(html).toContain('check your email');
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
  };

  it('renders each donor under its own name header, never a single merged view', () => {
    const html = portalView(data);
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
    };
    const html = portalView(maliciousData);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });

  it('links each donor to their own membership card', () => {
    const html = portalView(data);
    expect(html).toContain('/portal/card/donor-1');
    expect(html).toContain('/portal/card/donor-2');
  });
});
