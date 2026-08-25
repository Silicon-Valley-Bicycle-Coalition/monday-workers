import { describe, it, expect } from 'vitest';
import { changeRequestFormView, changeRequestResultView, changeRequestsUnavailableView } from './changeRequestViews';

const sampleDonor = { id: 'donor-1', name: 'Jane <b>Example</b>', email: 'jane@example.org', address: '1 Old St', phone: '555-0100', preferredLanguage: '' };
const donors = [
  sampleDonor,
  { id: 'donor-2', name: 'Sam Example', email: 'jane@example.org', address: '2 Shared Rd', phone: '', preferredLanguage: '' },
];

describe('changeRequestFormView', () => {
  it('shows each donor with their current values, escaped', () => {
    const html = changeRequestFormView(donors, 'en');
    expect(html).toContain('1 Old St');
    expect(html).toContain('2 Shared Rd');
    expect(html).not.toContain('<b>Example</b>');
    expect(html).toContain('&lt;b&gt;Example&lt;/b&gt;');
  });

  it('posts back to the locale-prefixed change-request route with the three expected fields', () => {
    const html = changeRequestFormView(donors, 'en');
    expect(html).toContain('action="/en/portal/change-request"');
    expect(html).toContain('name="donorItemId"');
    expect(html).toContain('name="field"');
    expect(html).toContain('name="newValue"');
  });

  it('the field select includes a Preferred Language option, localized', () => {
    const html = changeRequestFormView([sampleDonor], 'vi');
    expect(html).toContain('value="language"');
  });

  it('current-details list shows the stored preferred-language label', () => {
    const donor = { ...sampleDonor, preferredLanguage: 'Spanish' };
    const html = changeRequestFormView([donor], 'en');
    expect(html).toContain('Spanish');
  });
});

describe('changeRequestResultView', () => {
  it('confirms a submitted request and sets expectations about staff review', () => {
    const html = changeRequestResultView({ kind: 'submitted' }, 'en');
    expect(html).toContain('review');
  });
  it('explains a duplicate', () => {
    expect(changeRequestResultView({ kind: 'duplicate' }, 'en')).toContain('already');
  });
  it('shows the validation message', () => {
    expect(changeRequestResultView({ kind: 'invalid', message: 'Unknown field.' }, 'en')).toContain('Unknown field.');
  });
  it('locale-prefixes its "back to portal" / "back to form" links', () => {
    const submitted = changeRequestResultView({ kind: 'submitted' }, 'ja');
    expect(submitted).toContain('href="/ja/portal"');
  });
});

describe('changeRequestsUnavailableView', () => {
  it('says the feature is not available yet', () => {
    expect(changeRequestsUnavailableView('en')).toContain('not available yet');
  });
});
