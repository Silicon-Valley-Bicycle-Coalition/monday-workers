// Pure helpers for scripts/renewal-opt-out.mjs, kept apart so vitest can cover them without
// Salesforce or Mailchimp.
import md5 from 'md5';

export const DEFAULT_TAG = 'renewal-opt-out';
// Every email-typed field on SVBC's Contact (NPSP's four plus four custom ones), read
// 2026-11-17: any of them can be the address Mailchimp holds.
const EMAIL_FIELDS = [
  'Email', 'npe01__HomeEmail__c', 'npe01__WorkEmail__c', 'npe01__AlternateEmail__c',
  'Primary_Email__c', 'Secondary_Email__c', 'Email_3__c', 'Email_4__c',
];
export const OPT_OUT_SOQL = `SELECT Id, ${EMAIL_FIELDS.join(', ')} FROM Contact WHERE Renewal_Opt_Out__c = true`;

/** Mailchimp's member id: the MD5 of the lower-cased address. */
export function subscriberHash(email) {
  return md5(email.trim().toLowerCase());
}

/**
 * Every distinct address on the opted-out Contacts, lower-cased, across all their email fields.
 */
export function optOutEmails(records) {
  const out = new Set();
  let withoutEmail = 0;
  for (const r of records) {
    const emails = EMAIL_FIELDS.map((f) => String(r[f] ?? '').trim().toLowerCase()).filter((e) => e.includes('@'));
    if (emails.length === 0) withoutEmail += 1;
    for (const e of emails) out.add(e);
  }
  return { emails: [...out].sort(), contacts: records.length, withoutEmail };
}

/** Addresses from a CSV export with an `Email`/`email` header column (no quoted commas). */
export function emailsFromCsv(text) {
  const [header, ...rows] = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const cols = header.split(',').map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const idx = cols.indexOf('email');
  if (idx < 0) throw new Error('CSV has no "Email" column');
  return optOutEmails(rows.map((row) => ({ Email: row.split(',')[idx]?.replace(/^"|"$/g, '') })));
}

/**
 * What one member needs: `null` member → not in the audience (never created). Otherwise the
 * tag if it's missing, and the interest turned off if one was given and it's on.
 */
export function planMember(member, { tag, interestId }) {
  if (!member) return { kind: 'not-in-audience' };
  const hasTag = (member.tags ?? []).some((t) => t.name === tag);
  const interestOn = interestId ? member.interests?.[interestId] === true : false;
  return { kind: 'member', status: member.status, addTag: !hasTag, clearInterest: interestOn };
}

/** Counts by outcome, for a dry run's or an apply's summary. Never holds an address. */
export function summarize(plans) {
  const s = { total: plans.length, notInAudience: 0, byStatus: {}, addTag: 0, clearInterest: 0, nothingToDo: 0 };
  for (const p of plans) {
    if (p.kind === 'not-in-audience') { s.notInAudience += 1; continue; }
    s.byStatus[p.status] = (s.byStatus[p.status] ?? 0) + 1;
    if (p.addTag) s.addTag += 1;
    if (p.clearInterest) s.clearInterest += 1;
    if (!p.addTag && !p.clearInterest) s.nothingToDo += 1;
  }
  return s;
}
