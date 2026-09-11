import type { ItemPayload } from './types.js';
import { dateCol, fiscalYear, funraiseTransactionLink, ownerAttribution, salesforceDebug } from './fields.js';
import { attributionColumns } from './attribution.js';

// Closed Won is a distinct label, not plain "Received", on purpose: it's the same
// 438 stale-stage records docs/07 gotcha #4 found (IsWon = false, unlike Posted — see
// gotcha #10). Staff still see the gift succeeded, but donation-rollups (monday-workers)
// filters on Status === 'Received' exactly, so a shared label would silently pull these
// back into ongoing Lifetime Giving totals every time it recomputes, undoing the fix in
// transform/rollups.ts. See docs/17 for the full picklist audit.
const STATUS: Record<string, string> = {
  Posted: 'Received', 'Closed Won': 'Received (Historical)', 'Closed Lost': 'Failed',
};

// Donor precedence, then re-pointed through `donorAlias` when the fallback AccountId is a
// person-named Account folded into a Person (people.ts personNamedAccountIds) — otherwise
// the Donor link would target an Organization item that is never created.
const resolveDonor = (raw: unknown, donorAlias?: Map<string, string>): string | null => {
  const id = raw as string | null;
  return id ? (donorAlias?.get(id) ?? id) : null;
};

export interface OpportunityDeps {
  termCols: Map<string, Record<string, unknown>>;
  donorAlias?: Map<string, string>;
  // Accounts that become Organizations items (not One-to-One Individual, not person-named).
  // Only these can be a gift's Matched By target — a matching gift filed under a household
  // Account has no payer link.
  orgAccountIds?: Set<string>;
  // Placeholder donor records (config.placeholderDonorSfIds): a gift pointing at one is
  // anonymous — no Donor link, checkbox on — and never falls back to the Account either.
  placeholderDonorSfIds?: Set<string>;
  // Affiliation the Primary Contact acted for (transform/attribution.ts); additive to Donor.
  actingFor?: string | null;
}

const MATCHING_GIFT_TYPE = 'Matching Donation';

export function opportunityToPayload(o: Record<string, unknown>, deps: OpportunityDeps): ItemPayload {
  const orgAccountIds = deps.orgAccountIds ?? new Set<string>();
  const placeholders = deps.placeholderDonorSfIds ?? new Set<string>();
  const accountId = o['AccountId'] as string | null;
  const rawDonorId = resolveDonor(o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c'] ?? accountId,
    deps.donorAlias);
  const donorId = rawDonorId && !placeholders.has(rawDonorId) ? rawDonorId : null;
  const giftType = ((o['RecordType'] as { Name?: string } | null)?.Name ?? '') as string;
  const attribution = attributionColumns(deps.actingFor ?? null);
  const links: ItemPayload['links'] = [...attribution.links];
  if (donorId) links.push({ column: 'Donor', targetSfIds: [donorId] });
  // Employer matching gifts (Benevity): Donor is the employee the match is credited to (or the
  // company, when Benevity disclosed none); Matched By is always the paying company. Before
  // this, the company was dropped whenever a Primary Contact existed — 2,182 of 3,020 gifts.
  if (giftType === MATCHING_GIFT_TYPE && accountId && orgAccountIds.has(accountId)) {
    links.push({ column: 'Matched By', targetSfIds: [accountId] });
  }
  if (o['funraise__Subscription__c']) links.push({ column: 'Recurring Gift', targetSfIds: [o['funraise__Subscription__c'] as string] });
  if (o['CampaignId']) links.push({ column: 'Campaign', targetSfIds: [o['CampaignId'] as string] });
  return {
    board: 'donations',
    sfId: o['Id'] as string,
    name: (o['Name'] as string) ?? '(no name)',
    columns: {
      'Amount': o['Amount'] != null ? String(o['Amount']) : '',
      'Date': dateCol(o['CloseDate'] as string),
      'Fiscal Year Ending': fiscalYear(o['CloseDate'] as string | null),
      'Salesforce Owner': ownerAttribution(o['Owner']),
      'Status': { label: STATUS[o['StageName'] as string] ?? 'Pending' },
      'Gift Type': giftType,
      'Funraise ID': funraiseTransactionLink(o['funraise__fr_ID__c']),
      'Anonymous Donor': donorId ? null : { checked: 'true' },
      // Salesforce never stored Benevity's transaction id, so this is blank on every migrated
      // gift; declared here so load creates the column for the benevity-import Worker to fill.
      'Benevity Transaction ID': '',
      ...(deps.termCols.get(o['Id'] as string) ?? {}),
      ...attribution.columns,
      ...salesforceDebug(o),
    },
    links,
  };
}

export function cnpOverlapCheck(
  transactions: Record<string, unknown>[], opportunities: Record<string, unknown>[],
): { duplicateTransactionIds: string[]; unique: Record<string, unknown>[] } {
  const oppOrderNumbers = new Set(opportunities.map((o) => o['CnP_PaaS__CnP_OrderNumber__c']).filter(Boolean));
  const duplicateTransactionIds: string[] = [];
  const unique = transactions.filter((t) => {
    const txId = t['Id'] as string | null;
    if (txId && oppOrderNumbers.has(txId)) { duplicateTransactionIds.push(txId); return false; }
    return true;
  });
  return { duplicateTransactionIds, unique };
}

export function cnpToPayload(tx: Record<string, unknown>, donorAlias?: Map<string, string>): ItemPayload {
  const donorId = resolveDonor(tx['CnP_PaaS__Contact__c'] ?? tx['CnP_PaaS__Account__c'], donorAlias);
  return {
    board: 'donations',
    sfId: tx['Id'] as string,
    name: (tx['Name'] as string) ?? '(C&P transaction)',
    columns: {
      'Amount': tx['CnP_PaaS__TotalCharged__c'] != null ? String(tx['CnP_PaaS__TotalCharged__c']) : '',
      'Date': dateCol(tx['CnP_PaaS__TransactionDate__c'] as string),
      'Fiscal Year Ending': fiscalYear(tx['CnP_PaaS__TransactionDate__c'] as string | null),
      'Status': { label: 'Received' },
      'Gift Type': 'Click & Pledge (historical)',
      ...salesforceDebug(tx),
    },
    links: donorId ? [{ column: 'Donor', targetSfIds: [donorId] }] : [],
  };
}
