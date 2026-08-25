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
});

describe('verifyNotValidView', () => {
  it('says the card is not valid', () => {
    expect(verifyNotValidView()).toContain('not valid');
  });
});
