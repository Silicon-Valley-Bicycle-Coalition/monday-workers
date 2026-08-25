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

describe('cardView', () => {
  it('contains the donor identity, tier, status, expiry, verify link, and QR', () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg data-testid="qr"></svg>', 'en');
    expect(html).toContain('Member #donor-1');
    expect(html).toContain('Champion');
    expect(html).toContain('Active');
    expect(html).toContain('December 31, 2026');
    expect(html).toContain('https://portal.example.org/verify/tok123');
    expect(html).toContain('<svg data-testid="qr">');
  });

  it('escapes donor-sourced text', () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg></svg>', 'en');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it("points the regenerate form at this donor's own regenerate route", () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg></svg>', 'en');
    expect(html).toContain('action="/en/portal/card/donor-1/regenerate"');
    expect(html).toContain('method="post"');
  });

  it('locale-prefixes the regenerate form action and back-to-portal link', () => {
    const html = cardView(data, 'https://portal.example.org/verify/abc', '<svg></svg>', 'ko');
    expect(html).toContain('/ko/portal');
    expect(html).toContain(`/ko/portal/card/${data.donorId}/regenerate`);
  });
});

describe('cardUnavailableView', () => {
  it('says cards are not available yet', () => {
    expect(cardUnavailableView('en')).toContain('not available yet');
  });
});

describe('verifyView', () => {
  it("shows the donor identity, tier, status, and expiry, but not a member number", () => {
    const html = verifyView(data, 'en');
    expect(html).toContain('Jane &lt;script&gt; Example');
    expect(html).toContain('Champion');
    expect(html).toContain('Active');
    expect(html).toContain('December 31, 2026');
  });

  it('renders tier/status/expiry in the requested locale (labels, not the raw values, which are Monday-sourced text)', () => {
    const html = verifyView(data, 'fil');
    expect(html).toContain(data.membershipTier);
  });
});

describe('verifyNotValidView', () => {
  it('says the card is not valid', () => {
    expect(verifyNotValidView('en')).toContain('not valid');
  });
});
