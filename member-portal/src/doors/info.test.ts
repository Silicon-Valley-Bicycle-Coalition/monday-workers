import { describe, it, expect } from 'vitest';
import { infoDoorView, type InfoDoorData } from './info';
import { t } from '../i18n/t';
import { escapeHtml } from '../views';

const jane = {
  id: 'donor-1',
  name: 'Jane Donor',
  emails: [
    { address: 'jane@example.org', kind: 'personal' as const, label: 'verified' as const },
    { address: 'home@example.org', kind: 'household' as const, label: 'bounced' as const },
  ],
};
const contact = {
  id: 'donor-1',
  name: 'Jane Donor',
  email: 'jane@example.org',
  address: '1 Old St',
  phone: '555-0100',
  preferredLanguage: '',
  employer: '',
  emailOptOut: false,
  smsOptOut: null,
  doNotMail: null,
};

function data(overrides: Partial<InfoDoorData> = {}): InfoDoorData {
  return {
    form: { donors: [contact], prefFields: ['emailOptOut'], employerField: 'off' },
    people: [jane],
    household: false,
    emailsHidden: false,
    unavailableCount: 0,
    ...overrides,
  };
}

describe('infoDoorView', () => {
  it('frames the change form and preferences, then the address list, under the door title', () => {
    const html = infoDoorView(data(), 'en');
    expect(html).toContain(`<h1>${escapeHtml(t('en', 'home.doorInfo'))}</h1>`);
    expect(html).toContain('1 Old St');
    expect(html).toContain('action="/en/portal/change-request/preferences"');
    expect(html.indexOf('action="/en/portal/change-request"')).toBeLessThan(html.indexOf('class="email-list"'));
  });

  it('labels each address with its kind and status as text', () => {
    const html = infoDoorView(data(), 'en');
    expect(html).toContain('jane@example.org');
    expect(html).toContain(`<span class="email-kind">${t('en', 'info.kindPersonal')}</span>`);
    expect(html).toContain(`<span class="email-kind">${t('en', 'info.kindHousehold')}</span>`);
    expect(html).toContain(`<span class="email-label email-label-verified">${t('en', 'info.labelVerified')}</span>`);
    expect(html).toContain(`<span class="email-label email-label-bounced">${t('en', 'info.labelBounced')}</span>`);
  });

  it("leaves the current-details list without anyone's email: the address list is the one place addresses show", () => {
    const html = infoDoorView(data({ people: [{ ...jane, emails: [] }] }), 'en');
    expect(html).not.toContain('jane@example.org');
    expect(html).toContain(escapeHtml(t('en', 'info.emailsNone')));
  });

  it('shows the one-line note for a household session that hides addresses', () => {
    const html = infoDoorView(data({ household: true, emailsHidden: true, people: [{ ...jane, emails: [] }, { id: 'donor-2', name: 'Sam', emails: [] }] }), 'en');
    expect(html).toContain(escapeHtml(t('en', 'info.emailsHiddenHousehold')));
    expect(html).not.toContain('class="email-list"');
  });

  it('groups a household by name and leaves out a person with nothing to show', () => {
    const html = infoDoorView(
      data({
        household: true,
        people: [
          { id: 'donor-1', name: 'Jane Donor', emails: [{ address: 'home@example.org', kind: 'household', label: 'subscribed' }] },
          { id: 'donor-2', name: 'Sam Donor', emails: [] },
        ],
      }),
      'en'
    );
    expect(html).toContain('<h3>Jane Donor</h3>');
    expect(html).not.toContain('<h3>Sam Donor</h3>');
  });

  it('shows the unavailable copy in place of the form while change requests are off', () => {
    const html = infoDoorView(data({ form: null }), 'en');
    expect(html).toContain(escapeHtml(t('en', 'changeRequest.unavailableBody')));
    expect(html).not.toContain('action="/en/portal/change-request"');
    expect(html).toContain('class="email-list"');
  });

  it('omits the address section when every address read failed, with the note', () => {
    const html = infoDoorView(data({ people: [{ ...jane, emails: null }], unavailableCount: 1 }), 'en');
    expect(html).toContain(t('en', 'portal.someRecordsUnavailable'));
    expect(html).not.toContain(escapeHtml(t('en', 'info.emailsHeading')));
  });
});
