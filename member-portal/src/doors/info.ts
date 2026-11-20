// The Profile tab: the change-request form and communication preferences (formerly
// /portal/change-request), the member's email addresses with a text label each, then "Get a new
// code" for each card (cardCodeSection in card.ts, passed in). Which addresses show follows the
// privacy rule in emailLabels.ts.
import type { AppDeps } from '../routes';
import type { SessionInfo } from '../db/sessions';
import type { DonorContactInfo, DonorEmails, PrefField } from '../types';
import { changeRequestsEnabled, configuredPrefFields } from '../config';
import { pendingPreference, preferenceWindowStart } from '../changeRequests/submitPreferences';
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

type InfoDeps = Pick<AppDeps, 'monday' | 'config' | 'verifiedEmailStore' | 'changeStore' | 'now'>;

const NO_EMAILS: DonorEmails = { personal: '', household: '', personalConsent: '', householdConsent: '' };

// Each preference shows the member's newest request still in the dedupe window, else Monday: the
// writer applies a choice within moments, but Mailchimp's side reaches Personal Email Consent only
// on mailchimp-sync's hourly run, and a reload in between mustn't show the old choice. A failed
// read keeps Monday's value.
async function withPendingPreferences(donors: DonorContactInfo[], deps: InfoDeps): Promise<DonorContactInfo[]> {
  const sinceISO = preferenceWindowStart(deps.now(), deps.config.changeRequests.dedupeWindowHours);
  const fields = configuredPrefFields(deps.config);
  try {
    return await Promise.all(
      donors.map(async (donor) => {
        const pending = await Promise.all(fields.map((field) => pendingPreference(deps.changeStore, donor.id, field, sinceISO)));
        const next = { ...donor };
        fields.forEach((field, i) => {
          if (pending[i] !== null && pending[i] !== undefined) next[field] = pending[i];
        });
        return next;
      })
    );
  } catch (err) {
    console.error(`member-portal info door pending-preference read failed: ${errorText(err)}`);
    return donors;
  }
}

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

  const fetched = contacts.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  if (fetched.length === 0) return null;
  const donors = changeRequestsEnabled(deps.config) ? await withPendingPreferences(fetched, deps) : fetched;

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
const LABEL: Record<EmailLabel, { key: TranslationKey; hint: TranslationKey; className: string }> = {
  verified: { key: 'info.labelVerified', hint: 'info.hintVerified', className: 'verified' },
  subscribed: { key: 'info.labelSubscribed', hint: 'info.hintSubscribed', className: 'subscribed' },
  onFile: { key: 'info.labelOnFile', hint: 'info.hintOnFile', className: 'on-file' },
  bounced: { key: 'info.labelBounced', hint: 'info.hintBounced', className: 'bounced' },
};

// The label explains itself in a tooltip: shown on hover, keyboard focus or a tap, closed with
// Escape (portalTabs.ts), and read as the button's description by a screen reader.
function emailRow(email: ShownEmail, locale: Locale, tipId: string): string {
  const label = LABEL[email.label];
  return `<li><span class="email-address">${escapeHtml(email.address)}</span> <span class="email-kind">${escapeHtml(t(locale, KIND_KEY[email.kind]))}</span> <button type="button" class="email-label email-label-${label.className}" aria-describedby="${tipId}">${escapeHtml(t(locale, label.key))}<span class="email-tip" role="tooltip" id="${tipId}">${escapeHtml(t(locale, label.hint))}</span></button></li>`;
}

function emailsSection(data: InfoDoorData, locale: Locale): string {
  const heading = `<h2>${escapeHtml(t(locale, 'info.emailsHeading'))}</h2>`;
  if (data.emailsHidden) {
    return `<section class="info-emails">${heading}<p>${escapeHtml(t(locale, 'info.emailsHiddenNoAddress'))}</p></section>`;
  }
  const loaded = data.people.filter((person): person is InfoDoorPerson & { emails: ShownEmail[] } => person.emails !== null);
  if (loaded.length === 0) return '';
  let tipCount = 0;
  const groups = loaded
    .filter((person) => person.emails.length > 0)
    .map(
      (person) => `
      <div class="email-person">
        ${data.household ? `<h3>${escapeHtml(person.name)}</h3>` : ''}
        <ul class="email-list">${person.emails.map((email) => emailRow(email, locale, `email-tip-${tipCount++}`)).join('')}</ul>
      </div>`
    )
    .join('');
  const body = groups === '' ? `<p>${escapeHtml(t(locale, 'info.emailsNone'))}</p>` : groups;
  return `<section class="info-emails">${heading}${body}</section>`;
}

export interface InfoViewOptions {
  // "Get a new code" for each card (cardCodeSection in card.ts), shown last.
  cardCodes?: string;
  // ?change=<donor id>: render that person's change-request dialog already open (the no-script
  // path; any other value opens the first person's). An emailed ?field=employer opens the first.
  change?: string | null;
}

export function infoDoorView(data: InfoDoorData, locale: Locale, { cardCodes = '', change = null }: InfoViewOptions = {}): string {
  let form = `<p>${escapeHtml(t(locale, 'changeRequest.unavailableBody'))}</p>`;
  if (data.form !== null) {
    const ids = data.form.donors.map((d) => d.id);
    const openFor =
      change !== null ? (ids.includes(change) ? change : (ids[0] ?? null)) : data.form.employerField === 'preselected' ? (ids[0] ?? null) : null;
    // Prefill only a person's own Personal Email, and only when this tab already shows it.
    const emailPrefill = Object.fromEntries(
      data.people.flatMap((p) => {
        const personal = p.emails?.find((e) => e.kind === 'personal');
        return personal === undefined ? [] : [[p.id, personal.address]];
      })
    );
    form = changeRequestFormView(data.form.donors, locale, data.form.prefFields, { employerField: data.form.employerField, openFor, emailPrefill });
  }
  return tabPanel(t(locale, 'tabs.profile'), `${someRecordsUnavailableNote(data.unavailableCount, locale)}${form}${emailsSection(data, locale)}${cardCodes}`);
}
