import type { GeoResult } from '../geocode/cache.js';
import type { ItemPayload } from './types.js';
import type { MemberSummary } from './membership.js';
import { partnerTypeFor } from './partnerType.js';
import { collapseEmail, consentColumns, dateCol, funraiseSupporterLink, ownerAttribution, relationshipOwner, salesforceDebug } from './fields.js';

export interface InclusionInput {
  donorIds: Set<string>; recentDonorIds: Set<string>;
  memberSummaries: Map<string, MemberSummary>;
  // registrantIds: ever registered (Funraise or Eventbrite); recentRegistrantIds: for an event on or
  // after peopleActiveSinceISO — attending a recent class or shift is current engagement.
  registrantIds: Set<string>; recentRegistrantIds: Set<string>; volunteerIds: Set<string>;
  affiliatedIds: Set<string>; recentActivityIds: Set<string>;
  // On a staff volunteer roster (data/enrich/roster-contacts.txt, from the board-linking survey's
  // Volunteer Roster rows): included and live with no gift or check-in, so the roster's Person
  // links resolve (monday-migration docs/29 §6; decided 2026-10-26, svbc-monday-migration#83).
  rosterIds?: Set<string>;
}

/**
 * Contact ids listed in roster-contacts.txt, one per line (15 or 18 characters; blank lines and
 * `#` comments ignored), resolved to the extract's 18-character ids. Ids not in the extract are
 * dropped: the Contact was merged or deleted after the survey.
 */
export function rosterContactIds(text: string, contacts: Record<string, unknown>[]): Set<string> {
  const listed = new Set(text.split('\n').map((l) => l.replace(/#.*/, '').trim().slice(0, 15)).filter(Boolean));
  return new Set(contacts.map((c) => c['Id'] as string).filter((id) => listed.has(id.slice(0, 15))));
}

export function classifyContact(
  c: Record<string, unknown>, inc: InclusionInput, activeSinceISO: string,
): 'people-live' | 'people-historical' | null {
  const id = c['Id'] as string;
  const member = inc.memberSummaries.get(id);
  const included = member !== undefined || !!c['funraise__fr_ID__c'] ||
    inc.donorIds.has(id) || inc.registrantIds.has(id) ||
    inc.volunteerIds.has(id) || inc.affiliatedIds.has(id) || !!inc.rosterIds?.has(id);
  if (!included) return null;
  const live = !!c['funraise__fr_ID__c'] || !!inc.rosterIds?.has(id) ||
    inc.recentDonorIds.has(id) || inc.recentActivityIds.has(id) || inc.recentRegistrantIds.has(id) ||
    (member !== undefined && (member.status === 'Active' ||
      (member.untilISO !== null && member.untilISO >= activeSinceISO)));
  return live ? 'people-live' : 'people-historical';
}

const emailCol = (e: string | null) => (e ? { email: e, text: e } : null);

// City/Zip come from the geocode when there is one; otherwise from Salesforce's own fields, so an
// address with no street (never geocoded) or an unmatched one still filters by city. US ZIP+4 is
// cut to five digits to match what the geocoder writes; anything else is kept as written.
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
function cityZip(geo: GeoResult | undefined, city: unknown, zip: unknown): { City: string; Zip: string } {
  const z = clean(zip);
  return {
    City: geo?.city || clean(city),
    Zip: geo?.zip || (/^\d{5}(?:[- ]?\d{4})?$/.test(z) ? z.slice(0, 5) : z),
  };
}

export function contactToPayload(
  c: Record<string, unknown>, board: 'people-live' | 'people-historical',
  deps: {
    consent: Map<string, string>; member?: MemberSummary; geo?: GeoResult;
    // From transform/emails.ts. Absent → the pre-affiliation behavior: primary address is
    // Personal, Secondary_Email__c is Household, no work address is separated out.
    emails?: { personal: string | null; household: string | null };
    householdPrimary?: boolean;
    affiliationSfIds?: string[];
  },
): ItemPayload {
  const personal = deps.emails ? deps.emails.personal : collapseEmail(c);
  const household = deps.emails ? deps.emails.household
    : ((c['Secondary_Email__c'] as string | null)?.trim().toLowerCase() || null);
  const account = c['Account'] as { Do_Not_Solicit__c?: boolean; Do_Not_Solicit_What__c?: string;
    Owner?: { Name?: string } } | null;
  // Deceased (24 contacts, monday-migration docs/35 §3.1) has no column of its own: it suppresses
  // every solicitation, so it lands as Do Not Solicit with the reason saying why.
  const deceased = !!(c['Deceased__c'] || c['npsp__Deceased__c']);
  // NPSP Do Not Contact (75 contacts, #53) has no column of its own either: it suppresses both
  // solicitation and postal mail, so it sets both flags and names itself in both reasons.
  const dnc = !!c['npsp__Do_Not_Contact__c'];
  const DNC_REASON = 'Do Not Contact (Salesforce)';
  // Fundraise Opt Out (1,351 contacts, #86) is the solicitation opt-out staff actually used —
  // Account Do_Not_Solicit__c is set on 7. It is about fundraising only, so it sets Do Not
  // Solicit and leaves Do Not Mail as Salesforce had it.
  const fundraiseOptOut = !!c['Fundraise_Opt_Out__c'];
  const dnsReason = [deceased ? 'Deceased' : '', dnc ? DNC_REASON : '',
    fundraiseOptOut ? 'Fundraise Opt Out (Salesforce)' : '', account?.Do_Not_Solicit_What__c ?? '']
    .filter(Boolean).join('; ');
  const dnmReason = [(c['Do_Not_Mail_Reason__c'] ?? '') as string, dnc ? DNC_REASON : ''].filter(Boolean).join('; ');
  const columns: Record<string, unknown> = {
    'First Name': String(c['FirstName'] ?? '').trim(),
    'Last Name': String(c['LastName'] ?? '').trim(),
    'Personal Email': emailCol(personal),
    'Household Email': emailCol(household),
    'Phone': (c['Phone'] ?? c['MobilePhone'] ?? '') as string,
    'Address': [c['MailingStreet'], c['MailingCity'], c['MailingState'], c['MailingPostalCode']]
      .filter(Boolean).join(', '),
    'Funraise Profile': funraiseSupporterLink(c['funraise__fr_ID__c']),
    ...cityZip(deps.geo, c['MailingCity'], c['MailingPostalCode']),
    'Lat': deps.geo ? String(deps.geo.lat) : '', 'Lng': deps.geo ? String(deps.geo.lng) : '',
    'Do Not Solicit': account?.Do_Not_Solicit__c || deceased || dnc || fundraiseOptOut ?{ checked: 'true' } : null,
    'Do Not Solicit Reason': dnsReason,
    // Postal only (547 contacts): email consent comes from Mailchimp. Reason is "Opt out all mail"
    // or "Undeliverable" (a bad address to fix).
    'Do Not Mail': c['Do_Not_Mail__c'] || dnc ? { checked: 'true' } : null,
    'Do Not Mail Reason': dnmReason,
    // The one-to-one Account's owner, not a Contact-level owner field — matches how
    // monday-migration docs/05 §9 verified this (Account.OwnerId, not Contact.OwnerId).
    'Salesforce Owner': ownerAttribution(account?.Owner),
    // Donor portfolios (monday-migration docs/35 §3.5): seeded only where that owner is on staff.
    'Relationship Owner': relationshipOwner(account?.Owner),
    // Employer__c is the populated field (10,354 Contacts); dtd__company__c is 360MatchPro's
    // lookup, empty on every record (plan: Benevity in Integrations). Kept as a fallback only.
    'Employer Name': (c['Employer__c'] ?? c['dtd__company__c'] ?? '') as string,
    ...consentColumns(personal, household, deps.consent),
    ...salesforceDebug(c),
  };
  // A shared household address is one Mailchimp contact; this flag says whose merge fields it
  // carries (spec: "Consent and mailchimp-sync"). Only ever written as true.
  if (deps.householdPrimary) columns['Household Primary'] = { checked: 'true' };
  // Stakeholder Type's only Salesforce-sourced value (docs/22 §3.1; #46): Contact.Elected__c →
  // Elected Official, 366 contacts. Written only when set, so load creates the column — seeded
  // with the full label set from load/boards.ts STATUS_LABELS — before configure runs, and every
  // other person starts blank: City or Agency Staff and Partner Org Contact have no Salesforce
  // source, and Individual Donor is for staff to assign.
  if (c['Elected__c']) columns['Stakeholder Type'] = { label: 'Elected Official' };
  if (deps.member) {
    columns['Membership Status'] = { label: deps.member.status };
    columns['Membership Tier'] = { label: deps.member.tier };
    columns['Member Since'] = dateCol(deps.member.sinceISO);
    columns['Member Until'] = dateCol(deps.member.untilISO);
  }
  const links: ItemPayload['links'] = [];
  if (c['AccountId']) links.push({ column: 'Organization', targetSfIds: [c['AccountId'] as string] });
  if (deps.affiliationSfIds && deps.affiliationSfIds.length > 0) {
    links.push({ column: 'Affiliations', targetSfIds: deps.affiliationSfIds });
  }
  return {
    board, sfId: c['Id'] as string,
    name: [c['FirstName'], c['LastName']].filter(Boolean).join(' ') || '(no name)',
    columns,
    links,
  };
}

export const isOneToOneAccount = (a: Record<string, unknown>): boolean =>
  a['npe01__SYSTEM_AccountType__c'] === 'One-to-One Individual';

// Letters only, lower-cased — "D'Entremont-Partelow" and "d'entremont partelow" compare equal.
const nameKey = (s: unknown): string => String(s ?? '').toLowerCase().replace(/[^\p{L}]/gu, '');

/**
 * Blank-type Accounts that are really one person: NPSP only stamps `One-to-One Individual`
 * when its own trigger creates the Account, so Accounts created first (the 2013 bulk load,
 * Click & Pledge's Account-then-Contact writes) and then given a Contact never get it and
 * would otherwise land on the Organizations board. Rule: not one-to-one, at least one Contact,
 * and every attached Contact's name equals the Account name. Returns accountId → the Contact
 * the Account folds into (first of any same-named duplicates). Live org 2026-09-08: 204.
 *
 * An Account with no Contact left (a contact merge moved its only Contact away, 2026-10-26)
 * folds when every gift on it that names a Primary Contact names the same one, and that
 * Contact carries the Account's surname and first initial: the gifts' Primary Contact moved to
 * the survivor, which may spell the first name differently (Rose / Rosie, David / Dave).
 */
export function personNamedAccountIds(
  accounts: Record<string, unknown>[], contacts: Record<string, unknown>[],
  gifts: Record<string, unknown>[] = [],
): Map<string, string> {
  const byAccount = new Map<string, Record<string, unknown>[]>();
  for (const c of contacts) {
    const accountId = c['AccountId'] as string | null;
    if (!accountId) continue;
    if (!byAccount.has(accountId)) byAccount.set(accountId, []);
    byAccount.get(accountId)!.push(c);
  }
  const giftContacts = new Map<string, Set<string>>();
  for (const g of gifts) {
    const accountId = g['AccountId'] as string | null, contactId = g['npsp__Primary_Contact__c'] as string | null;
    if (accountId && contactId) (giftContacts.get(accountId) ?? giftContacts.set(accountId, new Set()).get(accountId)!).add(contactId);
  }
  const contactById = new Map(contacts.map((c) => [c['Id'] as string, c]));
  const named = (c: Record<string, unknown>, key: string) =>
    nameKey(`${c['FirstName'] ?? ''}${c['LastName'] ?? ''}`) === key;
  // Exactly "First Last" (no comma, ampersand or third word, so no firm names): the surname is
  // the Contact's and the first name starts with the Contact's initial.
  const nicknamed = (c: Record<string, unknown>, accountName: string) => {
    const m = /^([\p{L}'.-]+)\s+([\p{L}'.-]+)$/u.exec(accountName.trim());
    const first = nameKey(c['FirstName']), last = nameKey(c['LastName']);
    return !!m && !!first && !!last && nameKey(m[2]) === last && nameKey(m[1])[0] === first[0];
  };
  const out = new Map<string, string>();
  for (const a of accounts) {
    if (isOneToOneAccount(a)) continue;
    const id = a['Id'] as string, key = nameKey(a['Name']);
    if (!key) continue;
    const attached = byAccount.get(id);
    if (attached) {
      if (attached.every((c) => named(c, key))) out.set(id, attached[0]!['Id'] as string);
      continue;
    }
    const giftNamed = [...(giftContacts.get(id) ?? [])];
    const sole = giftNamed.length === 1 ? contactById.get(giftNamed[0]!) : undefined;
    if (sole && (named(sole, key) || nicknamed(sole, String(a['Name'])))) out.set(id, sole['Id'] as string);
  }
  return out;
}

export type PersonAccountGap = 'sole contact not migrated' | 'no contact' | 'several contacts';

/**
 * One-to-One Individual Accounts never become items, so a gift whose donor falls through to one
 * (no Primary Contact, no Funraise donor) would load with a dangling Donor link — 11,113 gifts in
 * the 2026-10-09 rehearsal (monday-migration docs/24). Decided 2026-10-26: an Account whose only
 * Contact is a migrated Person aliases to that Person; the rest are `unresolved`, with the reason,
 * for the review file. Built after inclusion, so it never makes anyone a Person.
 */
export function soleContactAccountIds(
  accounts: Record<string, unknown>[], contacts: Record<string, unknown>[], migrated: ReadonlySet<string>,
): { alias: Map<string, string>; unresolved: Map<string, PersonAccountGap> } {
  const byAccount = new Map<string, string[]>();
  for (const c of contacts) {
    const accountId = c['AccountId'] as string | null;
    if (accountId) (byAccount.get(accountId) ?? byAccount.set(accountId, []).get(accountId)!).push(c['Id'] as string);
  }
  const alias = new Map<string, string>(), unresolved = new Map<string, PersonAccountGap>();
  for (const a of accounts) {
    if (!isOneToOneAccount(a)) continue;
    const id = a['Id'] as string, attached = byAccount.get(id) ?? [];
    if (attached.length === 1 && migrated.has(attached[0]!)) alias.set(id, attached[0]!);
    else unresolved.set(id, attached.length === 0 ? 'no contact'
      : attached.length === 1 ? 'sole contact not migrated' : 'several contacts');
  }
  return { alias, unresolved };
}

export function accountToPayload(a: Record<string, unknown>, geo?: GeoResult): ItemPayload | null {
  if (isOneToOneAccount(a)) return null;
  return {
    board: 'organizations', sfId: a['Id'] as string, name: (a['Name'] as string) ?? '(no name)',
    columns: {
      // An unknown value loads blank (Untyped) rather than adding a label to the closed dropdown.
      'Partner Type': partnerTypeFor((a['Type'] ?? a['Type_2__c'] ?? a['Industry'] ?? '') as string) ?? '',
      'Website': (a['Website'] ?? '') as string,
      'Phone': (a['Phone'] ?? '') as string,
      'Address': [a['BillingStreet'], a['BillingCity'], a['BillingState'], a['BillingPostalCode']]
        .filter(Boolean).join(', '),
      ...cityZip(geo, a['BillingCity'], a['BillingPostalCode']),
      'Lat': geo ? String(geo.lat) : '', 'Lng': geo ? String(geo.lng) : '',
      'Do Not Solicit': a['Do_Not_Solicit__c'] ? { checked: 'true' } : null,
      'Do Not Solicit Reason': (a['Do_Not_Solicit_What__c'] ?? '') as string,
      'Salesforce Owner': ownerAttribution(a['Owner']),
      ...salesforceDebug(a),
    },
  };
}
