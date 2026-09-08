import type { GeoResult } from '../geocode/cache.js';
import type { ItemPayload } from './types.js';
import type { MemberSummary } from './membership.js';
import { collapseEmail, consentColumns, dateCol, funraiseSupporterLink, ownerAttribution, salesforceDebug } from './fields.js';

export interface InclusionInput {
  donorIds: Set<string>; recentDonorIds: Set<string>;
  memberSummaries: Map<string, MemberSummary>;
  registrantIds: Set<string>; volunteerIds: Set<string>;
  affiliatedIds: Set<string>; recentActivityIds: Set<string>;
}

export function classifyContact(
  c: Record<string, unknown>, inc: InclusionInput, activeSinceISO: string,
): 'people-live' | 'people-historical' | null {
  const id = c['Id'] as string;
  const member = inc.memberSummaries.get(id);
  const included = member !== undefined || !!c['funraise__fr_ID__c'] ||
    inc.donorIds.has(id) || inc.registrantIds.has(id) ||
    inc.volunteerIds.has(id) || inc.affiliatedIds.has(id);
  if (!included) return null;
  const live = !!c['funraise__fr_ID__c'] ||
    inc.recentDonorIds.has(id) || inc.recentActivityIds.has(id) ||
    (member !== undefined && (member.status === 'Active' ||
      (member.untilISO !== null && member.untilISO >= activeSinceISO)));
  return live ? 'people-live' : 'people-historical';
}

const emailCol = (e: string | null) => (e ? { email: e, text: e } : null);

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
  const columns: Record<string, unknown> = {
    'Personal Email': emailCol(personal),
    'Household Email': emailCol(household),
    'Phone': (c['Phone'] ?? c['MobilePhone'] ?? '') as string,
    'Address': [c['MailingStreet'], c['MailingCity'], c['MailingState'], c['MailingPostalCode']]
      .filter(Boolean).join(', '),
    'Funraise Profile': funraiseSupporterLink(c['funraise__fr_ID__c']),
    'City': deps.geo?.city ?? '', 'Zip': deps.geo?.zip ?? '',
    'Lat': deps.geo ? String(deps.geo.lat) : '', 'Lng': deps.geo ? String(deps.geo.lng) : '',
    'Do Not Solicit': account?.Do_Not_Solicit__c ? { checked: 'true' } : null,
    'Do Not Solicit Reason': (account?.Do_Not_Solicit_What__c ?? '') as string,
    // The one-to-one Account's owner, not a Contact-level owner field — matches how
    // monday-migration docs/05 §9 verified this (Account.OwnerId, not Contact.OwnerId).
    'Salesforce Owner': ownerAttribution(account?.Owner),
    'Employer Name': (c['dtd__company__c'] ?? '') as string,
    ...consentColumns(personal, household, deps.consent),
    ...salesforceDebug(c),
  };
  // A shared household address is one Mailchimp contact; this flag says whose merge fields it
  // carries (spec: "Consent and mailchimp-sync"). Only ever written as true.
  if (deps.householdPrimary) columns['Household Primary'] = { checked: 'true' };
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

export function accountToPayload(a: Record<string, unknown>, geo?: GeoResult): ItemPayload | null {
  if (a['npe01__SYSTEM_AccountType__c'] === 'One-to-One Individual') return null;
  return {
    board: 'organizations', sfId: a['Id'] as string, name: (a['Name'] as string) ?? '(no name)',
    columns: {
      'Partner Type': (a['Type'] ?? a['Type_2__c'] ?? a['Industry'] ?? '') as string,
      'Website': (a['Website'] ?? '') as string,
      'Phone': (a['Phone'] ?? '') as string,
      'Address': [a['BillingStreet'], a['BillingCity'], a['BillingState'], a['BillingPostalCode']]
        .filter(Boolean).join(', '),
      'City': geo?.city ?? '', 'Zip': geo?.zip ?? '',
      'Lat': geo ? String(geo.lat) : '', 'Lng': geo ? String(geo.lng) : '',
      'Do Not Solicit': a['Do_Not_Solicit__c'] ? { checked: 'true' } : null,
      'Do Not Solicit Reason': (a['Do_Not_Solicit_What__c'] ?? '') as string,
      'Salesforce Owner': ownerAttribution(a['Owner']),
      ...salesforceDebug(a),
    },
  };
}
