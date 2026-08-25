import { describe, it, expect } from 'vitest';
import { cardView, cardUnavailableView, verifyView, verifyNotValidView } from './cardViews';
import type { CardData } from './loadCardData';

const data: CardData = {
  donorId: 'donor-1',
  donorName: 'Jane <script> Example',
  memberNumber: 'Member #donor-1',
  membershipTier: 'Champion',
  membershipStatus: 'Active',
  expiryDisplay: 'December 31, 2026',
};

// Distinct payload per field so a broken/missing escapeHtml() call on any one
// field is caught, instead of only ever exercising donorName's escaping.
const xssData: CardData = {
  donorId: 'donor-1',
  donorName: '<script>alert("name")</script>',
  memberNumber: '<script>alert("number")</script>',
  membershipTier: '<script>alert("tier")</script>',
  membershipStatus: '<script>alert("status")</script>',
  expiryDisplay: '<script>alert("expiry")</script>',
};
const xssVerifyUrl = 'https://portal.example.org/verify/"><script>alert("url")</script>';

describe('cardView', () => {
  it('contains the donor identity, tier, status, expiry, verify link, and QR', () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg data-testid="qr"></svg>');
    expect(html).toContain('Member #donor-1');
    expect(html).toContain('Champion');
    expect(html).toContain('Active');
    expect(html).toContain('December 31, 2026');
    expect(html).toContain('https://portal.example.org/verify/tok123');
    expect(html).toContain('<svg data-testid="qr">');
  });

  it('escapes donor-sourced text', () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg></svg>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes every CRM-sourced field and the verify URL, not just donor name', () => {
    const html = cardView(xssData, xssVerifyUrl, '<svg></svg>');
    expect(html).not.toContain('<script>alert("name")</script>');
    expect(html).not.toContain('<script>alert("number")</script>');
    expect(html).not.toContain('<script>alert("tier")</script>');
    expect(html).not.toContain('<script>alert("status")</script>');
    expect(html).not.toContain('<script>alert("expiry")</script>');
    expect(html).not.toContain('<script>alert("url")</script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;name&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;number&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;tier&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;status&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;expiry&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;url&quot;)&lt;/script&gt;');
  });

  it("points the regenerate form at this donor's own regenerate route", () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg></svg>');
    expect(html).toContain('action="/portal/card/donor-1/regenerate"');
    expect(html).toContain('method="post"');
  });
});

describe('cardUnavailableView', () => {
  it('says cards are not available yet', () => {
    expect(cardUnavailableView()).toContain('not available yet');
  });
});

describe('verifyView', () => {
  it("shows the donor identity, tier, status, and expiry, but not a member number", () => {
    const html = verifyView(data);
    expect(html).toContain('Jane &lt;script&gt; Example');
    expect(html).toContain('Champion');
    expect(html).toContain('Active');
    expect(html).toContain('December 31, 2026');
  });

  it('escapes tier, status, and expiry, not just donor name', () => {
    const html = verifyView(xssData);
    expect(html).not.toContain('<script>alert("tier")</script>');
    expect(html).not.toContain('<script>alert("status")</script>');
    expect(html).not.toContain('<script>alert("expiry")</script>');
    expect(html).toContain('&lt;script&gt;alert(&quot;tier&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;status&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;expiry&quot;)&lt;/script&gt;');
  });
});

describe('verifyNotValidView', () => {
  it('says the card is not valid', () => {
    expect(verifyNotValidView()).toContain('not valid');
  });
});
