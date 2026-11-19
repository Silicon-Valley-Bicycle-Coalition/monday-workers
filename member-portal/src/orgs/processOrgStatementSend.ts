import type { MondayClient } from '../monday/client';
import type { OrgStatementSendStore } from '../db/orgStatementSends';
import type { MagicLinkTokenStore } from '../db/tokens';
import type { EmailSender } from '../email/types';
import type { Config } from '../types';
import type { OrgGrant } from './grants';
import { orgAccessEnabled } from '../config';
import { statementExists } from './loadOrgData';
import { localeFromMondayLabel, DEFAULT_LOCALE, type Locale } from '../i18n/locales';
import { generateToken } from '../crypto/token';
import { sha256Hex } from '../crypto/hash';
import { magicLinkUrl } from '../auth/magicLinkUrl';
import { errorText } from '../logSafe';

export interface ProcessOrgStatementSendDeps {
  store: OrgStatementSendStore;
  monday: MondayClient;
  tokenStore: MagicLinkTokenStore;
  emailSender: EmailSender;
  config: Config;
  now: () => Date;
}

// One organization statement email (a `kind: 'org'` message on the letter-emails queue), in
// processLetterSendBatch's processOne order: every check that can skip runs first, then the token
// is minted, the row claimed (queued → sending), the email sent, and the row marked sent. A throw
// is a retry; a deliberate skip marks the row 'skipped'.
export async function processOrgStatementSend(sendId: number, deps: ProcessOrgStatementSendDeps): Promise<void> {
  const row = await deps.store.getById(sendId);
  if (row === null) {
    // A message with no row is a bug worth surfacing: retries exhaust into the DLQ.
    throw new Error(`no org_statement_sends row for id ${sendId}`);
  }
  if (row.status === 'sending') {
    // Claimed by an earlier delivery that may have emailed: never resend automatically (the
    // statement is always in the portal; the email is only a notification).
    console.warn(`member-portal consumer: org statement send ${row.id} was already claimed by an earlier attempt — not re-sending`);
    return;
  }
  if (row.status !== 'queued') return; // redelivery after a crash between send/skip and ack

  const skip = () => deps.store.markSkipped(row.id, deps.now().toISOString());

  // A standing config gate, not a transient failure: skip, as the person letter does while unsigned.
  if (!orgAccessEnabled(deps.config)) return skip();

  // The rep may have lost access since the cron queued this: the same Current + Portal access +
  // same-organization check the organization pages run live.
  const aff = await deps.monday.getAffiliation(row.affiliationItemId);
  const current = deps.config.changeRequests.employer!.currentStatusLabel;
  if (aff === null || aff.statusLabel !== current || !aff.portalAccess || aff.organizationId !== row.orgItemId) return skip();

  const org = await deps.monday.getOrganization(row.orgItemId);
  if (org === null || !(await statementExists(row.orgItemId, row.year, deps))) return skip();

  // The Work Email when set, else the rep's Personal Email. The person is read either way when
  // linked, for the Preferred Language.
  const contact = aff.personItemId === null ? null : await deps.monday.getDonorContactInfo(aff.personItemId);
  const workEmail = aff.workEmail.trim();
  const via: OrgGrant['via'] = workEmail !== '' ? 'workEmail' : 'person';
  const recipient = via === 'workEmail' ? workEmail : (contact?.email.trim() ?? '');
  if (recipient === '') {
    console.error(`member-portal consumer: no email on file for affiliation ${aff.id} — skipping org statement send ${row.id}`);
    return skip();
  }

  // Minted before the claim, so a D1 failure leaves the row 'queued' for the retry. No people:
  // the link opens this one organization. The session's email hash is the recipient's, which a
  // Work Email grant's live check compares against the Affiliation's current Work Email.
  const grant: OrgGrant = { orgItemId: row.orgItemId, affiliationItemId: aff.id, via, personItemId: aff.personItemId };
  const rawToken = generateToken();
  await deps.tokenStore.createToken({
    tokenHash: await sha256Hex(rawToken),
    donorItemIds: [],
    expiresAt: new Date(deps.now().getTime() + deps.config.auth.letterLinkTtlHours * 3_600_000).toISOString(),
    orgGrants: [grant],
    emailHash: await sha256Hex(recipient.toLowerCase()),
  });

  const locale: Locale = localeFromMondayLabel(contact?.preferredLanguage ?? '') ?? DEFAULT_LOCALE;
  const next = `/${locale}/portal/org/${encodeURIComponent(row.orgItemId)}/statement/${row.year}`;
  const loginUrl = magicLinkUrl(deps.config.auth.portalBaseUrl, rawToken, locale, next);

  if (!(await deps.store.claimForSending(row.id, deps.now().toISOString()))) return; // a concurrent delivery won

  try {
    await deps.emailSender.sendOrgStatementReadyEmail({ to: recipient, orgName: org.name, year: row.year, loginUrl, locale });
  } catch (sendErr) {
    // Nothing went out: hand the row back for the retry. A failed release is logged, never masks the send error.
    try {
      await deps.store.releaseClaim(row.id);
    } catch (releaseErr) {
      console.error(
        `member-portal consumer: org statement send ${row.id} failed and its claim could not be released (row stays 'sending' — requeue by hand): ${errorText(releaseErr)}`
      );
    }
    throw sendErr;
  }

  try {
    await deps.store.markSent(row.id, deps.now().toISOString());
  } catch (err) {
    // The email is out and 'sending' already blocks a resend: log and let the message ack.
    console.error(`member-portal consumer: org statement send ${row.id} was emailed but not marked sent (row stays 'sending'): ${errorText(err)}`);
  }
}
