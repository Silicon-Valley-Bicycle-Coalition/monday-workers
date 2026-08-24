import { escapeHtml } from '../views';
import type { DonorContactInfo } from '../types';
import type { SubmitResult } from './submitChangeRequest';

function donorOption(donor: DonorContactInfo): string {
  return `<option value="${escapeHtml(donor.id)}">${escapeHtml(donor.name)}</option>`;
}

function donorCurrentValues(donor: DonorContactInfo): string {
  return `
    <section>
      <h3>${escapeHtml(donor.name)} — current details</h3>
      <dl>
        <dt>Address</dt><dd>${escapeHtml(donor.address)}</dd>
        <dt>Email</dt><dd>${escapeHtml(donor.email)}</dd>
        <dt>Phone</dt><dd>${escapeHtml(donor.phone)}</dd>
      </dl>
    </section>
  `;
}

export function changeRequestFormView(donors: DonorContactInfo[]): string {
  return `
    <h1>Request a change to your details</h1>
    <p>Submit the new value below. SVBC staff review every request before it's applied — you'll
    see the update once they've processed it.</p>
    ${donors.map(donorCurrentValues).join('')}
    <form action="/portal/change-request" method="post">
      <label>Whose record
        <select name="donorItemId" required>${donors.map(donorOption).join('')}</select>
      </label>
      <label>What to change
        <select name="field" required>
          <option value="address">Address</option>
          <option value="email">Email</option>
          <option value="phone">Phone</option>
        </select>
      </label>
      <label>New value
        <input type="text" name="newValue" maxlength="500" required />
      </label>
      <button type="submit">Submit for review</button>
    </form>
    <p>Note: an email change takes effect for portal login once staff apply it.</p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}

export function changeRequestResultView(result: SubmitResult): string {
  if (result.kind === 'submitted') {
    return `
      <h1>Request received</h1>
      <p>Thanks — SVBC staff will review your request and apply the change. This usually takes a
      few business days.</p>
      <p><a href="/portal">Back to your portal</a></p>
    `;
  }
  if (result.kind === 'duplicate') {
    return `
      <h1>Already submitted</h1>
      <p>We already have this exact request on file — staff will get to it soon. No need to
      submit it again.</p>
      <p><a href="/portal">Back to your portal</a></p>
    `;
  }
  return `
    <h1>Something needs fixing</h1>
    <p>${escapeHtml(result.message)}</p>
    <p><a href="/portal/change-request">Back to the form</a></p>
  `;
}

export function changeRequestsUnavailableView(): string {
  return `
    <h1>Request a change</h1>
    <p>Self-service change requests are not available yet. Please contact SVBC and we'll update
    your details for you.</p>
    <p><a href="/portal">Back to your portal</a></p>
  `;
}
