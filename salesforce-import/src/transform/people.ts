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
  deps: { consent: Map<string, string>; member?: MemberSummary; geo?: GeoResult },
): ItemPayload {
  const email = collapseEmail(c);
  const secondary = (c['Secondary_Email__c'] as string | null)?.trim().toLowerCase() || null;
  const account = c['Account'] as { Do_Not_Solicit__c?: boolean; Do_Not_Solicit_What__c?: string;
    Owner?: { Name?: string } } | null;
  const columns: Record<string, unknown> = {
    'Email': emailCol(email),
    'Secondary Email': emailCol(secondary),
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
    ...consentColumns(email, secondary, deps.consent),
    ...salesforceDebug(c),
  };
  if (deps.member) {
    columns['Membership Status'] = { label: deps.member.status };
    columns['Membership Tier'] = { label: deps.member.tier };
    columns['Member Since'] = dateCol(deps.member.sinceISO);
    columns['Member Until'] = dateCol(deps.member.untilISO);
  }
  return {
    board, sfId: c['Id'] as string,
    name: [c['FirstName'], c['LastName']].filter(Boolean).join(' ') || '(no name)',
    columns,
    links: c['AccountId'] ? [{ column: 'Organization', targetSfIds: [c['AccountId'] as string] }] : [],
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
 */
export function personNamedAccountIds(
  accounts: Record<string, unknown>[], contacts: Record<string, unknown>[],
): Map<string, string> {
  const byAccount = new Map<string, Record<string, unknown>[]>();
  for (const c of contacts) {
    const accountId = c['AccountId'] as string | null;
    if (!accountId) continue;
    if (!byAccount.has(accountId)) byAccount.set(accountId, []);
    byAccount.get(accountId)!.push(c);
  }
  const out = new Map<string, string>();
  for (const a of accounts) {
    if (isOneToOneAccount(a)) continue;
    const key = nameKey(a['Name']);
    const attached = byAccount.get(a['Id'] as string);
    if (!key || !attached) continue;
    if (attached.every((c) => nameKey(`${c['FirstName'] ?? ''}${c['LastName'] ?? ''}`) === key)) {
      out.set(a['Id'] as string, attached[0]!['Id'] as string);
    }
  }
  return out;
}

export function accountToPayload(a: Record<string, unknown>, geo?: GeoResult): ItemPayload | null {
  if (isOneToOneAccount(a)) return null;
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
