import { describe, it, expect } from 'vitest';
import { verifyView, verifyNotValidView } from './cardViews';
import type { CardData } from './loadCardData';
import { t } from '../i18n/t';

const data: CardData = {
  donorId: 'donor-1',
  donorName: 'Jane <script> Example',
  memberNumber: 'Member #donor-1',
  membershipTier: 'Champion',
  membershipStatus: 'Active',
  expiryDisplay: 'December 31, 2026',
  expiryShort: 'Dec 2026',
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
  expiryShort: '<script>alert("expiryShort")</script>',
};

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

  it('escapes tier, status, and expiry, not just donor name', () => {
    const html = verifyView(xssData, 'en');
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
    expect(verifyNotValidView('en')).toContain('not valid');
  });

  it('renders the not-valid message as real translated copy for a non-English locale', () => {
    expect(verifyNotValidView('fil')).toContain(t('fil', 'verify.notValid'));
  });
});
