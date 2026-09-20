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

function donorCurrentValues(donor: DonorContactInfo, locale: Locale): string {
  return `
    <section>
      <h3>${escapeHtml(t(locale, 'changeRequest.currentDetailsHeading', { name: donor.name }))}</h3>
      <dl>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldAddress'))}</dt><dd>${escapeHtml(donor.address)}</dd>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldEmail'))}</dt><dd>${escapeHtml(donor.email)}</dd>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldPhone'))}</dt><dd>${escapeHtml(donor.phone)}</dd>
        <dt>${escapeHtml(t(locale, 'changeRequest.fieldLanguage'))}</dt><dd>${escapeHtml(donor.preferredLanguage)}</dd>
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

function prefRadioPair(field: PrefField, optedOut: boolean, locale: Locale): string {
  const copy = PREF_COPY[field];
  return `
    <fieldset>
      <legend>${escapeHtml(t(locale, copy.label))}</legend>
      <label><input type="radio" name="${field}" value="yes"${optedOut ? ' checked' : ''} /> ${escapeHtml(t(locale, copy.yes))}</label>
      <label><input type="radio" name="${field}" value="no"${optedOut ? '' : ' checked'} /> ${escapeHtml(t(locale, copy.no))}</label>
    </fieldset>
  `;
}

function donorPreferencesForm(donor: DonorContactInfo, prefFields: PrefField[], locale: Locale): string {
  return `
    <section>
      <h3>${escapeHtml(t(locale, 'changeRequest.prefsHeading', { name: donor.name }))}</h3>
      <form action="/${locale}/portal/change-request/preferences" method="post">
        <input type="hidden" name="donorItemId" value="${escapeHtml(donor.id)}" />
        ${prefFields.map((field) => prefRadioPair(field, donor[field] === true, locale)).join('')}
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

export function changeRequestFormView(donors: DonorContactInfo[], locale: Locale, prefFields: PrefField[]): string {
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.formHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'changeRequest.formIntro'))}</p>
    ${donors.map((d) => donorCurrentValues(d, locale)).join('')}
    <form action="/${locale}/portal/change-request" method="post">
      <label>${escapeHtml(t(locale, 'changeRequest.whoseRecord'))}
        <select name="donorItemId" required>${donors.map(donorOption).join('')}</select>
      </label>
      <label>${escapeHtml(t(locale, 'changeRequest.whatToChange'))}
        <select name="field" required>
          <option value="address">${escapeHtml(t(locale, 'changeRequest.fieldAddress'))}</option>
          <option value="email">${escapeHtml(t(locale, 'changeRequest.fieldEmail'))}</option>
          <option value="phone">${escapeHtml(t(locale, 'changeRequest.fieldPhone'))}</option>
          <option value="language">${escapeHtml(t(locale, 'changeRequest.fieldLanguage'))}</option>
        </select>
      </label>
      <label>${escapeHtml(t(locale, 'changeRequest.newValue'))}
        <input type="text" name="newValue" maxlength="500" required />
      </label>
      <button type="submit">${escapeHtml(t(locale, 'changeRequest.submit'))}</button>
    </form>
    <p>${escapeHtml(t(locale, 'changeRequest.emailNote'))}</p>
    ${preferencesSection(donors, prefFields, locale)}
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}

// Maps the diff-based preferences result onto the existing result copy where it fits: any fresh
// submission reads as "submitted", all-duplicates as "already submitted"; only the
// nothing-changed case needs copy of its own.
export function preferencesResultView(result: PreferencesResult, locale: Locale): string {
  if (result.kind === 'submitted') {
    return changeRequestResultView({ kind: result.submitted > 0 ? 'submitted' : 'duplicate' }, locale);
  }
  if (result.kind === 'invalid') {
    return changeRequestResultView(result, locale);
  }
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.prefsNoChangesHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'changeRequest.prefsNoChangesBody'))}</p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}

export function changeRequestResultView(result: SubmitResult, locale: Locale): string {
  if (result.kind === 'submitted') {
    return `
      <h1>${escapeHtml(t(locale, 'changeRequest.submittedHeading'))}</h1>
      <p>${escapeHtml(t(locale, 'changeRequest.submittedBody'))}</p>
      <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
    `;
  }
  if (result.kind === 'duplicate') {
    return `
      <h1>${escapeHtml(t(locale, 'changeRequest.duplicateHeading'))}</h1>
      <p>${escapeHtml(t(locale, 'changeRequest.duplicateBody'))}</p>
      <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
    `;
  }
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.invalidHeading'))}</h1>
    <p>${escapeHtml(result.message)}</p>
    <p><a href="/${locale}/portal/change-request">${escapeHtml(t(locale, 'changeRequest.backToForm'))}</a></p>
  `;
}

export function changeRequestsUnavailableView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'changeRequest.unavailableHeading'))}</h1>
    <p>${escapeHtml(t(locale, 'changeRequest.unavailableBody'))}</p>
    <p><a href="/${locale}/portal">${escapeHtml(t(locale, 'letters.backToPortal'))}</a></p>
  `;
}
