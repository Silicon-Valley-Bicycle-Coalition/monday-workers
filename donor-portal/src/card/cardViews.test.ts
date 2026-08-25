import { describe, it, expect } from 'vitest';
import { cardView, cardUnavailableView, verifyView, verifyNotValidView } from './cardViews';
import type { CardData } from './loadCardData';
import { t } from '../i18n/t';

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

  it('renders actual translated copy for the requested locale, not just structure', () => {
    const html = cardView(data, 'https://portal.example.org/verify/tok123', '<svg></svg>', 'ko');
    expect(html).toContain(t('ko', 'card.regenerateHint'));
  });
});

describe('cardUnavailableView', () => {
  it('says cards are not available yet', () => {
    expect(cardUnavailableView('en')).toContain('not available yet');
  });

  it('renders the unavailable message as real translated copy for a non-English locale', () => {
    expect(cardUnavailableView('ko')).toContain(t('ko', 'card.unavailable'));
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
    // The raw Monday-sourced value still shows up (it's not locale-dependent), but that alone
    // doesn't prove the labels around it are translated — this view would pass that check even if
    // verifyView ignored its locale argument entirely. Assert real Filipino copy too.
    expect(html).toContain(data.membershipTier);
    expect(html).toContain(t('fil', 'verify.disclaimer'));
  });
});

describe('verifyNotValidView', () => {
  it('says the card is not valid', () => {
    expect(verifyNotValidView('en')).toContain('not valid');
  });

  it('renders the not-valid message as real translated copy for a non-English locale', () => {
    expect(verifyNotValidView('fil')).toContain(t('fil', 'verify.notValid'));
  });
});
