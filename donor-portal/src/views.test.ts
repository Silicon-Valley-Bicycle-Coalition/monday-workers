import { describe, it, expect } from 'vitest';
import { checkEmailView, errorView, loginFormView, portalView } from './views';
import type { PortalView } from './types';

describe('loginFormView', () => {
  it('renders a form posting to /login with an email field', () => {
    const html = loginFormView();
    expect(html).toContain('action="/login"');
    expect(html).toContain('name="email"');
  });
});

describe('checkEmailView', () => {
  it('renders the same generic message regardless of caller state', () => {
    const html = checkEmailView();
    expect(html).toContain('check your email');
  });
});

describe('errorView', () => {
  it('renders the given message, escaped', () => {
    const html = errorView('<script>alert(1)</script>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
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
      },
      {
        id: 'donor-2',
        name: 'Jane Also',
        membershipStatus: 'Active',
        membershipTier: 'Lifetime',
        totalDonated: '2500',
        donations: [],
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
        },
      ],
      discounts: [],
    };
    const html = portalView(maliciousData);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;img');
  });
});
