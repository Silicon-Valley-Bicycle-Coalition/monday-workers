// The Profile tab: the change-request form and communication preferences (formerly
// /portal/change-request), the member's email addresses with a text label each, then "Get a new
// code" for each card (cardCodeSection in card.ts, passed in). Which addresses show follows the
// privacy rule in emailLabels.ts.
import type { AppDeps } from '../routes';
import type { SessionInfo } from '../db/sessions';
import type { DonorContactInfo, DonorEmails, PrefField } from '../types';
import { changeRequestsEnabled, configuredPrefFields } from '../config';
import { changeRequestFormView, type EmployerFieldMode } from '../changeRequests/changeRequestViews';
import type { Locale } from '../i18n/locales';
import { t, type TranslationKey } from '../i18n/t';
import { errorText } from '../logSafe';
import { escapeHtml, someRecordsUnavailableNote } from '../views';
import { tabPanel } from './layout';
import { signInEmailHash, visibleEmails, type EmailLabel, type ShownEmail } from './emailLabels';

export interface InfoDoorPerson {
  id: string;
  name: string;
  // null when this person's address read failed.
  emails: ShownEmail[] | null;
}

export interface InfoDoorData {
  // null while change requests are off (the form and preferences both need them).
  form: { donors: DonorContactInfo[]; prefFields: PrefField[]; employerField: EmployerFieldMode } | null;
  // Everyone whose record loaded, in session order.
  people: InfoDoorPerson[];
  household: boolean;
  // A session that doesn't know which address it signed in with (a letter-ready link, or one from
  // before migration 0008) shows none, whatever its size.
  emailsHidden: boolean;
  unavailableCount: number;
}

type InfoDeps = Pick<AppDeps, 'monday' | 'config' | 'verifiedEmailStore'>;

const NO_EMAILS: DonorEmails = { personal: '', household: '', personalConsent: '', householdConsent: '' };

// Each read degrades on its own: a failed contact read drops that person (their name comes from
// it); a failed address read drops only their addresses; a failed verified-row read only loses
// the Verified label. null when no one's record loaded at all.
export async function loadInfoDoor(session: SessionInfo, deps: InfoDeps, employerField: EmployerFieldMode): Promise<InfoDoorData | null> {
  const ids = session.donorItemIds;
  const household = ids.length > 1;
  const emailsHidden = session.emailHash === null;

  const [contacts, emailReads, verified] = await Promise.all([
    Promise.allSettled(ids.map((id) => deps.monday.getDonorContactInfo(id))),
    emailsHidden ? Promise.resolve(null) : Promise.allSettled(ids.map((id) => deps.monday.getDonorEmails(id))),
    emailsHidden
      ? Promise.resolve(new Set<string>())
      : deps.verifiedEmailStore.verifiedFor(ids).catch((err: unknown) => {
          console.error(`member-portal info door verified-address read failed: ${errorText(err)}`);
          return new Set<string>();
        }),
  ]);

  const failed = new Set<string>();
  contacts.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed.add(ids[index]!);
      console.error(`member-portal info door contact read failed for donor "${ids[index]}": ${errorText(result.reason)}`);
    }
  });
  emailReads?.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed.add(ids[index]!);
      console.error(`member-portal info door address read failed for donor "${ids[index]}": ${errorText(result.reason)}`);
    }
  });

  const donors = contacts.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  if (donors.length === 0) return null;

  const shown =
    emailReads === null
      ? {}
      : await visibleEmails(
          ids.map((id, index) => {
            const read = emailReads[index]!;
            return { id, emails: read.status === 'fulfilled' ? read.value : NO_EMAILS };
          }),
          session.emailHash,
          verified,
          signInEmailHash
        );

  const people = donors.map((donor) => {
    const index = ids.indexOf(donor.id);
    const read = emailReads?.[index];
    const emails = emailsHidden ? [] : read?.status === 'fulfilled' ? (shown[donor.id] ?? []) : null;
    return { id: donor.id, name: donor.name, emails };
  });

  return {
    form: changeRequestsEnabled(deps.config) ? { donors, prefFields: configuredPrefFields(deps.config), employerField } : null,
    people,
    household,
    emailsHidden,
    unavailableCount: failed.size,
  };
}

const KIND_KEY: Record<ShownEmail['kind'], TranslationKey> = { personal: 'info.kindPersonal', household: 'info.kindHousehold' };
const LABEL: Record<EmailLabel, { key: TranslationKey; className: string }> = {
  verified: { key: 'info.labelVerified', className: 'verified' },
  subscribed: { key: 'info.labelSubscribed', className: 'subscribed' },
  onFile: { key: 'info.labelOnFile', className: 'on-file' },
  bounced: { key: 'info.labelBounced', className: 'bounced' },
};

function emailRow(email: ShownEmail, locale: Locale): string {
  const label = LABEL[email.label];
  return `<li><span class="email-address">${escapeHtml(email.address)}</span> <span class="email-kind">${escapeHtml(t(locale, KIND_KEY[email.kind]))}</span> <span class="email-label email-label-${label.className}">${escapeHtml(t(locale, label.key))}</span></li>`;
}

function emailsSection(data: InfoDoorData, locale: Locale): string {
  const heading = `<h2>${escapeHtml(t(locale, 'info.emailsHeading'))}</h2>`;
  if (data.emailsHidden) {
    return `<section class="info-emails">${heading}<p>${escapeHtml(t(locale, 'info.emailsHiddenNoAddress'))}</p></section>`;
  }
  const loaded = data.people.filter((person): person is InfoDoorPerson & { emails: ShownEmail[] } => person.emails !== null);
  if (loaded.length === 0) return '';
  const groups = loaded
    .filter((person) => person.emails.length > 0)
    .map(
      (person) => `
      <div class="email-person">
        ${data.household ? `<h3>${escapeHtml(person.name)}</h3>` : ''}
        <ul class="email-list">${person.emails.map((email) => emailRow(email, locale)).join('')}</ul>
      </div>`
    )
    .join('');
  const body =
    groups === ''
      ? `<p>${escapeHtml(t(locale, 'info.emailsNone'))}</p>`
      : `${groups}<p class="email-legend">${escapeHtml(t(locale, 'info.emailsLegend'))}</p>`;
  return `<section class="info-emails">${heading}${body}</section>`;
}

export function infoDoorView(data: InfoDoorData, locale: Locale, cardCodes = ''): string {
  const form =
    data.form === null
      ? `<p>${escapeHtml(t(locale, 'changeRequest.unavailableBody'))}</p>`
      : changeRequestFormView(data.form.donors, locale, data.form.prefFields, data.form.employerField);
  return tabPanel(t(locale, 'tabs.profile'), `${someRecordsUnavailableNote(data.unavailableCount, locale)}${form}${emailsSection(data, locale)}${cardCodes}`);
}
