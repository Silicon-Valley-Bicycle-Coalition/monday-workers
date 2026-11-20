import { describe, it, expect } from 'vitest';
import { changeRequestFormView, changeRequestResultView, changeRequestsUnavailableView, preferencesResultView } from './changeRequestViews';
import { t } from '../i18n/t';
import { escapeHtml } from '../views';

const sampleDonor = { id: 'donor-1', name: 'Jane <b>Example</b>', email: 'jane@example.org', address: '1 Old St', phone: '555-0100', preferredLanguage: '', employer: '', emailOptOut: false, smsOptOut: false, doNotMail: false };
const donors = [
  sampleDonor,
  { id: 'donor-2', name: 'Sam Example', email: 'jane@example.org', address: '2 Shared Rd', phone: '', preferredLanguage: '', employer: '', emailOptOut: false, smsOptOut: false, doNotMail: false },
];

describe('changeRequestFormView', () => {
  it('shows each donor with their current values, escaped', () => {
    const html = changeRequestFormView(donors, 'en', []);
    expect(html).toContain('1 Old St');
    expect(html).toContain('2 Shared Rd');
    expect(html).not.toContain('<b>Example</b>');
    expect(html).toContain('&lt;b&gt;Example&lt;/b&gt;');
  });

  it('posts back to the locale-prefixed change-request route with the three expected fields', () => {
    const html = changeRequestFormView(donors, 'en', []);
    expect(html).toContain('action="/en/portal/change-request"');
    expect(html).toContain('name="donorItemId"');
    expect(html).toContain('name="field"');
    expect(html).toContain('name="newValue"');
  });

  it('the field select includes a Preferred Language option, localized', () => {
    const html = changeRequestFormView([sampleDonor], 'vi', []);
    expect(html).toContain('value="language"');
  });

  it('renders actual translated copy for the requested locale, not just structure', () => {
    const html = changeRequestFormView([sampleDonor], 'vi', []);
    expect(html).toContain(t('vi', 'changeRequest.formHeading'));
  });

  // The info door's address list applies the household privacy rule; this list must not leak
  // another person's Personal Email around it.
  it("leaves every donor's email out of the current-details list", () => {
    const html = changeRequestFormView(donors, 'en', []);
    expect(html).not.toContain('jane@example.org');
    expect(html).not.toContain(`<dt>${t('en', 'changeRequest.fieldEmail')}</dt>`);
  });

  it('current-details list shows the stored preferred-language label', () => {
    const donor = { ...sampleDonor, preferredLanguage: 'Spanish' };
    const html = changeRequestFormView([donor], 'en', []);
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
  it('links back to the locale-prefixed info door', () => {
    expect(changeRequestResultView({ kind: 'submitted' }, 'ja')).toContain('href="/ja/portal/info"');
    expect(changeRequestResultView({ kind: 'duplicate' }, 'ja')).toContain('href="/ja/portal/info"');
    expect(changeRequestResultView({ kind: 'invalid', message: 'x' }, 'ja')).toContain('href="/ja/portal/info"');
    expect(preferencesResultView({ kind: 'noChanges' }, 'ja')).toContain('href="/ja/portal/info"');
    expect(changeRequestsUnavailableView('ja')).toContain('href="/ja/portal/info"');
  });

  it('renders actual translated copy for the requested locale, not just structure', () => {
    const submitted = changeRequestResultView({ kind: 'submitted' }, 'ja');
    expect(submitted).toContain(t('ja', 'changeRequest.submittedHeading'));
  });
});

describe('changeRequestsUnavailableView', () => {
  it('says the feature is not available yet', () => {
    expect(changeRequestsUnavailableView('en')).toContain('not available yet');
  });

  it('renders the unavailable message as real translated copy for a non-English locale', () => {
    expect(changeRequestsUnavailableView('ja')).toContain(t('ja', 'changeRequest.unavailableBody'));
  });
});

describe('changeRequestFormView — communication preferences section', () => {
  const optedOutDonor = { ...sampleDonor, name: 'Jane Example', emailOptOut: true, smsOptOut: false, doNotMail: false };

  it('renders a per-donor preferences form posting to the preferences route', () => {
    const html = changeRequestFormView([optedOutDonor], 'en', ['emailOptOut', 'smsOptOut', 'doNotMail']);
    expect(html).toContain('action="/en/portal/change-request/preferences"');
    expect(html).toContain('name="donorItemId" value="donor-1"');
  });

  it('pre-checks each radio from the donor state (true = opted out)', () => {
    const html = changeRequestFormView([optedOutDonor], 'en', ['emailOptOut', 'smsOptOut']);
    expect(html).toMatch(/name="emailOptOut" value="yes"[^>]* checked/);
    expect(html).not.toMatch(/name="emailOptOut" value="no"[^>]* checked/);
    expect(html).toMatch(/name="smsOptOut" value="no"[^>]* checked/);
  });

  it('lays the preferences out as a table: channel row header, receive choice, then opt-out choice', () => {
    const html = changeRequestFormView([optedOutDonor], 'en', ['emailOptOut', 'doNotMail']);
    expect(html).toContain('<table class="prefs-table">');
    expect(html).not.toContain('<fieldset');
    expect(html).toContain(`<th scope="row" id="pref-donor-1-emailOptOut">${t('en', 'changeRequest.prefEmailOptOut')}</th>`);
    expect(html).toContain('name="emailOptOut" value="no" aria-describedby="pref-donor-1-emailOptOut"');
    const row = html.slice(html.indexOf('id="pref-donor-1-doNotMail"'));
    expect(row.indexOf(t('en', 'changeRequest.prefMailNo'))).toBeLessThan(row.indexOf(t('en', 'changeRequest.prefMailYes')));
  });

  it('shows the details with no section heading, then a Request a change link that opens the form in a closed dialog', () => {
    const html = changeRequestFormView([optedOutDonor], 'en', []);
    expect(html).toContain(`<h2 class="visually-hidden">${t('en', 'profile.detailsHeading')}</h2>`);
    expect(html).toContain('href="/en/portal/info?change=1" data-dialog-open="change-request"');
    expect(html).toContain('<dialog id="change-request" class="portal-dialog" aria-labelledby="change-request-title">');
    expect(html.indexOf('<dl>')).toBeLessThan(html.indexOf('<dialog'));
    expect(html.indexOf('<dialog')).toBeLessThan(html.indexOf('action="/en/portal/change-request"'));
    expect(html).toContain('<form method="dialog" class="dialog-close">');
  });

  it('renders the dialog open when asked (no-script ?change=1, or ?field=employer)', () => {
    expect(changeRequestFormView([optedOutDonor], 'en', [], 'on', true)).toContain('aria-labelledby="change-request-title" open data-open-on-load>');
  });

  it('asks whose record only for a household; one person posts their id as a hidden field', () => {
    const single = changeRequestFormView([optedOutDonor], 'en', []);
    expect(single).not.toContain(t('en', 'changeRequest.whoseRecord'));
    expect(single).not.toContain('<select name="donorItemId"');
    const changeForm = single.slice(single.indexOf('action="/en/portal/change-request"'));
    expect(changeForm).toContain('<input type="hidden" name="donorItemId" value="donor-1" />');
    const household = changeRequestFormView([optedOutDonor, { ...optedOutDonor, id: 'donor-2', name: 'Sam' }], 'en', []);
    expect(household).toContain(t('en', 'changeRequest.whoseRecord'));
    expect(household).toContain('<select name="donorItemId" required>');
  });

  it('heads sections by name only: no per-person heading for one person, just the name in a household', () => {
    const single = changeRequestFormView([optedOutDonor], 'en', ['emailOptOut']);
    expect(single).toContain(`<h2>${t('en', 'changeRequest.prefsSectionHeading')}</h2>`);
    expect(single).not.toContain('<h3>');
    const household = changeRequestFormView([optedOutDonor, { ...optedOutDonor, id: 'donor-2', name: 'Sam' }], 'en', ['emailOptOut']);
    expect(household.match(/<h3>Sam<\/h3>/g)).toHaveLength(2);
    expect(household).not.toContain('Sam — ');
  });

  it('renders only the configured preference fields', () => {
    const html = changeRequestFormView([optedOutDonor], 'en', ['doNotMail']);
    expect(html).toContain('name="doNotMail"');
    expect(html).not.toContain('name="emailOptOut"');
    expect(html).not.toContain('name="smsOptOut"');
  });

  it('omits the preferences section entirely when no preference column is configured', () => {
    const html = changeRequestFormView([optedOutDonor], 'en', []);
    expect(html).not.toContain('/portal/change-request/preferences');
  });

  it('renders one preferences form per donor on a shared-email account', () => {
    const second = { ...optedOutDonor, id: 'donor-2', name: 'Sam Example' };
    const html = changeRequestFormView([optedOutDonor, second], 'en', ['emailOptOut']);
    expect(html).toContain('name="donorItemId" value="donor-1"');
    expect(html).toContain('name="donorItemId" value="donor-2"');
  });

  it('renders translated copy for the preferences section', () => {
    const html = changeRequestFormView([optedOutDonor], 'vi', ['emailOptOut']);
    expect(html).toContain(t('vi', 'changeRequest.prefsSubmit'));
  });
});

describe('preferencesResultView', () => {
  it.each([
    ['a fresh save', { submitted: 2, duplicates: 0 }],
    ['a repeat of one already on file', { submitted: 0, duplicates: 1 }],
  ])('confirms %s as received, with no staff-review wording', (_label, counts) => {
    const html = preferencesResultView({ kind: 'submitted', ...counts }, 'en');
    expect(html).toContain(t('en', 'changeRequest.prefsReceivedHeading'));
    expect(html).toContain(escapeHtml(t('en', 'changeRequest.prefsReceivedBody')));
    expect(html).not.toContain(escapeHtml(t('en', 'changeRequest.submittedBody')));
    expect(html).toContain('href="/en/portal/info"');
  });

  it('tells the donor when nothing changed', () => {
    const html = preferencesResultView({ kind: 'noChanges' }, 'en');
    expect(html).toContain(t('en', 'changeRequest.prefsNoChangesHeading'));
  });

  it('surfaces invalid submissions with the escaped message', () => {
    const html = preferencesResultView({ kind: 'invalid', message: '<script>bad</script>' }, 'en');
    expect(html).toContain(t('en', 'changeRequest.invalidHeading'));
    expect(html).not.toContain('<script>bad</script>');
  });
});

describe('changeRequestFormView — employer', () => {
  const donor = { ...sampleDonor, employer: 'Acme <Corp>' };

  it('offers Employer and shows the current one when enabled', () => {
    const html = changeRequestFormView([donor], 'en', [], 'on');
    expect(html).toContain('<option value="employer">Employer</option>');
    expect(html).toContain('<dt>Employer</dt><dd>Acme &lt;Corp&gt;</dd>');
  });

  it('preselects Employer', () => {
    expect(changeRequestFormView([donor], 'en', [], 'preselected')).toContain('<option value="employer" selected>Employer</option>');
  });

  it('shows neither while off', () => {
    const html = changeRequestFormView([donor], 'en', []);
    expect(html).not.toContain('value="employer"');
    expect(html).not.toContain('<dt>Employer</dt>');
  });
});
