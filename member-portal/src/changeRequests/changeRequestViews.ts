import { escapeHtml } from '../views';
import type { DonorContactInfo, PrefField } from '../types';
import type { SubmitResult } from './submitChangeRequest';
import type { PreferencesResult } from './submitPreferences';
import type { ContactChangesResult } from './submitContactChanges';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';
import type { TranslationKey } from '../i18n/t';

// 'off': no Employer field; 'on': offered; 'preselected': offered and chosen (?field=employer).
export type EmployerFieldMode = 'off' | 'on' | 'preselected';

// No email row: the info door's address list is the one place addresses show, under the
// household privacy rule (src/doors/emailLabels.ts).

// The section heading names what this is; a household's per-person heading is just the name.
function personHeading(donor: DonorContactInfo, household: boolean): string {
  return household ? `<h3>${escapeHtml(donor.name)}</h3>` : '';
}

function donorCurrentValues(donor: DonorContactInfo, locale: Locale, employerField: EmployerFieldMode, household: boolean): string {
  const employerRow =
    employerField === 'off'
      ? ''
      : `<dt>${escapeHtml(t(locale, 'changeRequest.fieldEmployer'))}</dt><dd>${escapeHtml(donor.employer)}</dd>`;
  return `
    <section>
      ${personHeading(donor, household)}
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
  // The last cell is where the tab script shows the spinning wheel while that row saves, then a
  // check; it's a polite live region so a screen reader hears "Saving…" and "Saved".
  return `<tr><th scope="row" id="${headerId}">${escapeHtml(t(locale, copy.label))}</th>${choice('no', copy.no, !optedOut)}${choice('yes', copy.yes, optedOut)}<td class="pref-status" aria-live="polite"></td></tr>`;
}

// With the tab script each change saves as it's made (no button); without it, the form posts.
function donorPreferencesForm(donor: DonorContactInfo, prefFields: PrefField[], locale: Locale, household: boolean): string {
  return `
    <section>
      ${personHeading(donor, household)}
      <form class="prefs-form" action="/${locale}/portal/change-request/preferences" method="post">
        <input type="hidden" name="donorItemId" value="${escapeHtml(donor.id)}" />
        <table class="prefs-table" data-saving="${escapeHtml(t(locale, 'changeRequest.prefsSaving'))}" data-saved="${escapeHtml(t(locale, 'changeRequest.prefsSaved'))}">
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
    <h2>${escapeHtml(t(locale, 'changeRequest.prefsSectionHeading'))}</h2>
    <p>${escapeHtml(t(locale, 'changeRequest.prefsIntro'))}</p>
    ${donors.map((d) => donorPreferencesForm(d, prefFields, locale, donors.length > 1)).join('')}
  `;
}

// One field of the contact form: its label, a "Changed" mark the tab script shows once the value
// differs from what was prefilled (with the highlight, so the cue isn't colour alone), the input.
function contactField(name: string, label: TranslationKey, value: string, locale: Locale, attrs: string): string {
  return `<label class="contact-field">
          <span class="contact-field-label">${escapeHtml(t(locale, label))} <span class="changed-mark">${escapeHtml(t(locale, 'changeRequest.changedMark'))}</span></span>
          <input name="${name}" value="${escapeHtml(value)}" maxlength="500" ${attrs} />
        </label>`;
}

export interface ContactFormOptions {
  employerField?: EmployerFieldMode;
  // The donor whose dialog renders already open: ?change=<id> (the no-script path; any other
  // value opens the first person's), or the first person for an emailed ?field=employer.
  openFor?: string | null;
  // The email address to prefill per donor id: only one the session may already see on this tab
  // (src/doors/info.ts). Anyone else's field starts empty, and an empty field is no change.
  emailPrefill?: Record<string, string>;
}

// Each person's details on file, then their "Request a change" link and dialog: the whole contact
// form, prefilled, posting every field (submitContactChanges files one request per changed field).
function personContact(donor: DonorContactInfo, index: number, household: boolean, locale: Locale, options: ContactFormOptions): string {
  const employerField = options.employerField ?? 'off';
  const id = `change-request-${index}`;
  const open = options.openFor === donor.id;
  const employer =
    employerField === 'off'
      ? ''
      : contactField('employer', 'changeRequest.fieldEmployer', donor.employer, locale, `type="text" autocomplete="organization"${open && employerField === 'preselected' ? ' autofocus' : ''}`);
  return `
    ${donorCurrentValues(donor, locale, employerField, household)}
    <p><a class="outline-button" href="/${locale}/portal/info?change=${encodeURIComponent(donor.id)}" data-dialog-open="${id}">${escapeHtml(t(locale, 'profile.requestChange'))}</a></p>
    <dialog id="${id}" class="portal-dialog" aria-labelledby="${id}-title"${open ? ' open data-open-on-load' : ''}>
      <form method="dialog" class="dialog-close"><button type="submit" aria-label="${escapeHtml(t(locale, 'dialog.close'))}"><span aria-hidden="true">×</span></button></form>
      <h2 id="${id}-title">${escapeHtml(t(locale, 'changeRequest.formHeading'))}</h2>
      ${household ? `<p class="contact-form-person">${escapeHtml(donor.name)}</p>` : ''}
      <p>${escapeHtml(t(locale, 'changeRequest.formIntro'))}</p>
      <form class="contact-form" action="/${locale}/portal/change-request" method="post">
        <input type="hidden" name="donorItemId" value="${escapeHtml(donor.id)}" />
        <input type="hidden" name="emailWas" value="${escapeHtml(options.emailPrefill?.[donor.id] ?? '')}" />
        ${contactField('address', 'changeRequest.fieldAddress', donor.address, locale, 'type="text" autocomplete="street-address"')}
        ${contactField('email', 'changeRequest.fieldEmail', options.emailPrefill?.[donor.id] ?? '', locale, 'type="email" autocomplete="email"')}
        ${contactField('phone', 'changeRequest.fieldPhone', donor.phone, locale, 'type="tel" autocomplete="tel"')}
        ${contactField('language', 'changeRequest.fieldLanguage', donor.preferredLanguage, locale, 'type="text"')}
        ${employer}
        <button type="submit">${escapeHtml(t(locale, 'changeRequest.submit'))}</button>
      </form>
      <p>${escapeHtml(t(locale, 'changeRequest.emailNote'))}</p>
    </dialog>`;
}

// The Profile tab's first section (src/doors/info.ts, which supplies the tab heading and the
// unavailable-records note): each person's details with a "Request a change" link and dialog, then
// communication preferences. The tab script opens a dialog as a modal; with no script the link
// reloads the tab with ?change=<id>, which renders that dialog open in place.
export function changeRequestFormView(donors: DonorContactInfo[], locale: Locale, prefFields: PrefField[], options: ContactFormOptions = {}): string {
  const household = donors.length > 1;
  // The heading is for screen-reader navigation only; on screen the details lead the tab.
  return `
    <h2 class="visually-hidden">${escapeHtml(t(locale, 'profile.detailsHeading'))}</h2>
    ${donors.map((d, i) => personContact(d, i, household, locale, options)).join('')}
    ${preferencesSection(donors, prefFields, locale)}
  `;
}

// Maps the whole-form result onto the change request's result copy: any fresh request reads as
// "submitted", all repeats as "already submitted", nothing changed gets its own note.
export function contactChangesResultView(result: ContactChangesResult, locale: Locale): string {
  if (result.kind === 'submitted') return changeRequestResultView({ kind: result.submitted > 0 ? 'submitted' : 'duplicate' }, locale);
  if (result.kind === 'invalid') return changeRequestResultView(result, locale);
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.prefsNoChangesHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'changeRequest.noChangesBody'))}</p>
    ${backToInfo(locale)}
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
