import type { OrgAffiliation, OrgGift } from '../monday/client';
import type { AffiliationRecord } from '../changeRequests/employer';

// The sandbox test organization behind the org-rep test accounts (see personas.ts). One
// organization with a donation, a sponsorship and an employee match in the last completed year
// (so a year-end statement exists) plus a gift this year, and one Affiliation: Morgan Orgrep,
// Current, Portal access ticked, with a Work Email that signs in to the organization alone.
// Every id starts with "test-", so withTestAccounts answers it and Monday never sees it.

export const TEST_ORG_ID = 'test-org';
export const TEST_ORG_AFFILIATION_ID = 'test-aff-orgrep';
export const TEST_ORG_WORK_EMAIL = 'test-orgrep-work@example.org';
const REP_PERSON_ID = 'test-orgrep';

export const TEST_ORG = { id: TEST_ORG_ID, name: 'Example Bikes Inc. (test)', address: '900 Test Plaza, San José, CA 95113' };

// `currentStatusLabel` is the deployment's Affiliations "Current" label, so the grant checks pass.
export function testOrgAffiliation(currentStatusLabel: string): OrgAffiliation {
  return {
    id: TEST_ORG_AFFILIATION_ID,
    personItemId: REP_PERSON_ID,
    organizationId: TEST_ORG_ID,
    statusLabel: currentStatusLabel,
    portalAccess: true,
    workEmail: TEST_ORG_WORK_EMAIL,
  };
}

// The rep's own Affiliations as the person-side read returns them.
export function testPersonAffiliations(personItemId: string, currentStatusLabel: string): AffiliationRecord[] {
  if (personItemId !== REP_PERSON_ID) return [];
  return [
    {
      id: TEST_ORG_AFFILIATION_ID,
      organizationId: TEST_ORG_ID,
      organizationName: TEST_ORG.name,
      statusLabel: currentStatusLabel,
      primary: true,
      portalAccess: true,
    },
  ];
}

// Gifts whose Donor is the organization: last year's donation and sponsorship, and one this year.
export function testOrgGifts(now: Date): OrgGift[] {
  const lastYear = now.getUTCFullYear() - 1;
  const thisYear = now.getUTCFullYear();
  return [
    { itemId: 'test-org-gift-1', date: `${lastYear}-03-15`, amount: '1000.00', giftType: 'Donation' },
    { itemId: 'test-org-gift-2', date: `${lastYear}-05-01`, amount: '2500.00', giftType: 'Sponsorship' },
    { itemId: 'test-org-gift-3', date: `${thisYear}-01-10`, amount: '500.00', giftType: 'Donation' },
  ];
}

// Employee gifts the organization matched (Matched By): date and amount only on the pages.
export function testOrgMatches(now: Date): OrgGift[] {
  const lastYear = now.getUTCFullYear() - 1;
  return [{ itemId: 'test-org-match-1', date: `${lastYear}-09-20`, amount: '150.00', giftType: 'Matching Donation' }];
}

export function isTestOrgWorkEmail(email: string): boolean {
  return email.trim().toLowerCase() === TEST_ORG_WORK_EMAIL;
}
