import { escapeHtml } from '../views';
import type { DonorContactInfo, PrefField } from '../types';
import type { SubmitResult } from './submitChangeRequest';
import type { PreferencesResult } from './submitPreferences';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';
import type { TranslationKey } from '../i18n/t';

function donorOption(donor: DonorContactInfo): string {
  return `<option value="${escapeHtml(donor.id)}">${escapeHtml(donor.name)}</option>`;
}

// "Whose record" only for a household; one person's form carries their id as a hidden field.
function whoseRecord(donors: DonorContactInfo[], locale: Locale): string {
  if (donors.length === 1) return `<input type="hidden" name="donorItemId" value="${escapeHtml(donors[0]!.id)}" />`;
  return `<label>${escapeHtml(t(locale, 'changeRequest.whoseRecord'))}
          <select name="donorItemId" required>${donors.map(donorOption).join('')}</select>
        </label>`;
}

// 'off': no Employer field; 'on': offered; 'preselected': offered and chosen (?field=employer).
export type EmployerFieldMode = 'off' | 'on' | 'preselected';

// No email row: the info door's address list is the one place addresses show, under the
// household privacy rule (src/doors/emailLabels.ts).
function donorCurrentValues(donor: DonorContactInfo, locale: Locale, employerField: EmployerFieldMode): string {
  const employerRow =
    employerField === 'off'
      ? ''
      : `<dt>${escapeHtml(t(locale, 'changeRequest.fieldEmployer'))}</dt><dd>${escapeHtml(donor.employer)}</dd>`;
  return `
    <section>
      <h3>${escapeHtml(t(locale, 'changeRequest.currentDetailsHeading', { name: donor.name }))}</h3>
      <dl>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldAddress'))}</dt><dd>${escapeHtml(donor.address)}</dd>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldPhone'))}</dt><dd>${escapeHtml(donor.phone)}</dd>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldLanguage'))}</dt><dd>${escapeHtml(donor.preferredLanguage)}</dd>
        ${employerRow}
      </dl>
    </section>
  `;
}

// Per-preference i18n keys: the field's own label plus its two radio labels ("yes" always means
// the restrictive state — opted out / do not mail — matching PreferencesInput's booleans).
const PREF_COPY: Record<PrefField, { label: TranslationKey; yes: TranslationKey; no: TranslationKey }> = {
  emailOptOut: { label: 'changeRequest.prefEmailOptOut', yes: 'changeRequest.prefOptOutYes', no: 'changeRequest.prefOptOutNo' },
  smsOptOut: { label: 'changeRequest.prefSmsOptOut', yes: 'changeRequest.prefOptOutYes', no: 'changeRequest.prefOptOutNo' },
  doNotMail: { label: 'changeRequest.prefDoNotMail', yes: 'changeRequest.prefMailYes', no: 'changeRequest.prefMailNo' },
};

// One table row per preference: the channel as the row header, then its two choices, the receiving
// one first, so every row's choices line up in the same two columns. Each radio is described by
// its row header, so tabbing between them still names the channel.
function prefRow(donorId: string, field: PrefField, optedOut: boolean, locale: Locale): string {
  const copy = PREF_COPY[field];
  const headerId = escapeHtml(`pref-${donorId}-${field}`);
  const choice = (value: 'yes' | 'no', key: TranslationKey, checked: boolean) =>
    `<td><label><input type="radio" name="${field}" value="${value}" aria-describedby="${headerId}"${checked ? ' checked' : ''} /> ${escapeHtml(t(locale, key))}</label></td>`;
  return `<tr><th scope="row" id="${headerId}">${escapeHtml(t(locale, copy.label))}</th>${choice('no', copy.no, !optedOut)}${choice('yes', copy.yes, optedOut)}</tr>`;
}

function donorPreferencesForm(donor: DonorContactInfo, prefFields: PrefField[], locale: Locale): string {
  return `
    <section>
      <h3>${escapeHtml(t(locale, 'changeRequest.prefsHeading', { name: donor.name }))}</h3>
      <form class="prefs-form" action="/${locale}/portal/change-request/preferences" method="post">
        <input type="hidden" name="donorItemId" value="${escapeHtml(donor.id)}" />
        <table class="prefs-table">
          <tbody>${prefFields.map((field) => prefRow(donor.id, field, donor[field] === true, locale)).join('')}</tbody>
        </table>
        <button type="submit">${escapeHtml(t(locale, 'changeRequest.prefsSubmit'))}</button>
      </form>
    </section>
  `;
}

function preferencesSection(donors: DonorContactInfo[], prefFields: PrefField[], locale: Locale): string {
  if (prefFields.length === 0) return '';
  return `
    <h2>${escapeHtml(t(locale, 'changeRequest.prefsIntro'))}</h2>
    ${donors.map((d) => donorPreferencesForm(d, prefFields, locale)).join('')}
  `;
}

// The dialog's id; the "Request a change" link names it in data-dialog-open (portalTabs.ts).
export const CHANGE_REQUEST_DIALOG_ID = 'change-request';

// The Profile tab's first section (src/doors/info.ts, which supplies the tab heading and the
// unavailable-records note): each person's details on file, a "Request a change" link, the
// change-request form in a <dialog>, then communication preferences. The tab script opens the
// dialog as a modal; with no script the link reloads the tab with ?change=1, which renders the
// dialog open in place (openForm), as does an emailed ?field=employer.
export function changeRequestFormView(
  donors: DonorContactInfo[],
  locale: Locale,
  prefFields: PrefField[],
  employerField: EmployerFieldMode = 'off',
  openForm = false
): string {
  const employerOption =
    employerField === 'off'
      ? ''
      : `<option value="employer"${employerField === 'preselected' ? ' selected' : ''}>${escapeHtml(t(locale, 'changeRequest.fieldEmployer'))}</option>`;
  const id = CHANGE_REQUEST_DIALOG_ID;
  return `
    <h2>${escapeHtml(t(locale, 'profile.detailsHeading'))}</h2>
    ${donors.map((d) => donorCurrentValues(d, locale, employerField)).join('')}
    <p><a class="outline-button" href="/${locale}/portal/info?change=1" data-dialog-open="${id}">${escapeHtml(t(locale, 'profile.requestChange'))}</a></p>
    <dialog id="${id}" class="portal-dialog" aria-labelledby="${id}-title"${openForm ? ' open data-open-on-load' : ''}>
      <form method="dialog" class="dialog-close"><button type="submit" aria-label="${escapeHtml(t(locale, 'dialog.close'))}"><span aria-hidden="true">×</span></button></form>
      <h2 id="${id}-title">${escapeHtml(t(locale, 'changeRequest.formHeading'))}</h2>
      <p>${escapeHtml(t(locale, 'changeRequest.formIntro'))}</p>
      <form action="/${locale}/portal/change-request" method="post">
        ${whoseRecord(donors, locale)}
        <label>${escapeHtml(t(locale, 'changeRequest.whatToChange'))}
          <select name="field" required>
            <option value="address">${escapeHtml(t(locale, 'changeRequest.fieldAddress'))}</option>
            <option value="email">${escapeHtml(t(locale, 'changeRequest.fieldEmail'))}</option>
            <option value="phone">${escapeHtml(t(locale, 'changeRequest.fieldPhone'))}</option>
            <option value="language">${escapeHtml(t(locale, 'changeRequest.fieldLanguage'))}</option>
            ${employerOption}
          </select>
        </label>
        <label>${escapeHtml(t(locale, 'changeRequest.newValue'))}
          <input type="text" name="newValue" maxlength="500" required />
        </label>
        <button type="submit">${escapeHtml(t(locale, 'changeRequest.submit'))}</button>
      </form>
      <p>${escapeHtml(t(locale, 'changeRequest.emailNote'))}</p>
    </dialog>
    ${preferencesSection(donors, prefFields, locale)}
  `;
}

// Every result page leads back to the info door, where the form lives.
function backToInfo(locale: Locale): string {
  return `<p><a href="/${locale}/portal/info"><span aria-hidden="true">‹ </span>${escapeHtml(t(locale, 'tabs.profile'))}</a></p>`;
}

// Preferences aren't reviewed by staff, so a save (fresh or a repeat of one already on file)
// gets its own "received" copy rather than the change request's "staff will review"; an invalid
// one reuses the change request's error page.
export function preferencesResultView(result: PreferencesResult, locale: Locale): string {
  if (result.kind === 'submitted') {
    return `
    <h1>${escapeHtml(t(locale, 'changeRequest.prefsReceivedHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'changeRequest.prefsReceivedBody'))}</p>
    ${backToInfo(locale)}
  `;
  }
  if (result.kind === 'invalid') {
    return changeRequestResultView(result, locale);
  }
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.prefsNoChangesHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'changeRequest.prefsNoChangesBody'))}</p>
    ${backToInfo(locale)}
  `;
}

export function changeRequestResultView(result: SubmitResult, locale: Locale): string {
  if (result.kind === 'submitted') {
    return `
      <h1>${escapeHtml(t(locale, 'changeRequest.submittedHeading'))}</h1>
      <p>${escapeHtml(t(locale, 'changeRequest.submittedBody'))}</p>
      ${backToInfo(locale)}
    `;
  }
  if (result.kind === 'duplicate') {
    return `
      <h1>${escapeHtml(t(locale, 'changeRequest.duplicateHeading'))}</h1>
      <p>${escapeHtml(t(locale, 'changeRequest.duplicateBody'))}</p>
      ${backToInfo(locale)}
    `;
  }
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.invalidHeading'))}</h1>
    <p>${escapeHtml(result.message)}</p>
    <p><a href="/${locale}/portal/info">${escapeHtml(t(locale, 'changeRequest.backToForm'))}</a></p>
  `;
}

export function changeRequestsUnavailableView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.unavailableHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'changeRequest.unavailableBody'))}</p>
    ${backToInfo(locale)}
  `;
}
