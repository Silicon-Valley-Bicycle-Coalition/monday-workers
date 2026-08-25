import { escapeHtml } from '../views';
import type { DonorContactInfo } from '../types';
import type { SubmitResult } from './submitChangeRequest';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';

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

export function changeRequestFormView(donors: DonorContactInfo[], locale: Locale): string {
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
