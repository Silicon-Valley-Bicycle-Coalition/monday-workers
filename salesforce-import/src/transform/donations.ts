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

export function opportunityToPayload(
  o: Record<string, unknown>,
  deps: { termCols: Map<string, Record<string, unknown>>; actingFor?: string | null },
): ItemPayload {
  const donorId = (o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c'] ?? o['AccountId']) as string | null;
  const attribution = attributionColumns(deps.actingFor ?? null);
  const links: ItemPayload['links'] = [...attribution.links];
  if (donorId) links.push({ column: 'Donor', targetSfIds: [donorId] });
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
      'Gift Type': ((o['RecordType'] as { Name?: string } | null)?.Name ?? '') as string,
      'Funraise ID': funraiseTransactionLink(o['funraise__fr_ID__c']),
      'Anonymous Donor': donorId ? null : { checked: 'true' },
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

export function cnpToPayload(tx: Record<string, unknown>): ItemPayload {
  const donorId = (tx['CnP_PaaS__Contact__c'] ?? tx['CnP_PaaS__Account__c']) as string | null;
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
