import type { ItemPayload } from './types.js';
import { dateCol, provenanceColumns } from './fields.js';
import { eraFor, type Era } from './eras.js';

const STATUS: Record<string, string> = {
  Posted: 'Received', 'Closed Won': 'Received', 'Closed Lost': 'Failed',
};

export function opportunityToPayload(
  o: Record<string, unknown>,
  deps: { eras: Era[]; termCols: Map<string, Record<string, unknown>> },
): ItemPayload {
  const donorId = (o['npsp__Primary_Contact__c'] ?? o['funraise__fr_Donor__c'] ?? o['AccountId']) as string | null;
  const links: ItemPayload['links'] = [];
  if (donorId) links.push({ column: 'Donor', targetSfIds: [donorId] });
  if (o['funraise__Subscription__c']) links.push({ column: 'Recurring Gift', targetSfIds: [o['funraise__Subscription__c'] as string] });
  if (o['CampaignId']) links.push({ column: 'Campaign', targetSfIds: [o['CampaignId'] as string] });
  return {
    board: eraFor(o['CloseDate'] as string | null, deps.eras),
    sfId: o['Id'] as string,
    name: (o['Name'] as string) ?? '(no name)',
    columns: {
      'SF ID': o['Id'],
      'Amount': o['Amount'] != null ? String(o['Amount']) : '',
      'Date': dateCol(o['CloseDate'] as string),
      'Status': { label: STATUS[o['StageName'] as string] ?? 'Pending' },
      'Gift Type': ((o['RecordType'] as { Name?: string } | null)?.Name ?? '') as string,
      'Funraise ID': (o['funraise__fr_ID__c'] ?? '') as string,
      'Anonymous Donor': donorId ? null : { checked: 'true' },
      ...(deps.termCols.get(o['Id'] as string) ?? {}),
      ...provenanceColumns(o),
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

export function cnpToPayload(tx: Record<string, unknown>, deps: { eras: Era[] }): ItemPayload {
  const donorId = (tx['CnP_PaaS__Contact__c'] ?? tx['CnP_PaaS__Account__c']) as string | null;
  return {
    board: eraFor(tx['CnP_PaaS__TransactionDate__c'] as string | null, deps.eras),
    sfId: tx['Id'] as string,
    name: (tx['Name'] as string) ?? '(C&P transaction)',
    columns: {
      'SF ID': tx['Id'],
      'Amount': tx['CnP_PaaS__TotalCharged__c'] != null ? String(tx['CnP_PaaS__TotalCharged__c']) : '',
      'Date': dateCol(tx['CnP_PaaS__TransactionDate__c'] as string),
      'Status': { label: 'Received' },
      'Gift Type': 'Click & Pledge (historical)',
      ...provenanceColumns(tx),
    },
    links: donorId ? [{ column: 'Donor', targetSfIds: [donorId] }] : [],
  };
}
