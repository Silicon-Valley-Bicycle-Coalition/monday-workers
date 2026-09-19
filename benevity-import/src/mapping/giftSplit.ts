import type { ParsedRow } from '../parse/report';
import type { BenevityImportConfig } from '../types';
import { fiscalYearEnding } from './fiscalYear';

export interface GiftContext {
  row: ParsedRow;
  disbursementPeriodEnding: string;
  organizationItemId: string;
  // null means no Person was resolved (anonymous or withheld) — never a placeholder for "not yet looked up".
  personItemId: string | null;
}

export interface GiftSpec {
  transactionId: string;
  itemName: string;
  columnValues: Record<string, unknown>;
}

export function splitRowIntoGifts(ctx: GiftContext, config: BenevityImportConfig): GiftSpec[] {
  const { row, disbursementPeriodEnding, organizationItemId, personItemId } = ctx;
  const cols = config.benevityImport.donationsColumns;
  const donorLabel = personItemId ? `${row.donorFirstName} ${row.donorLastName}`.trim() : 'Anonymous';
  const fyEnding = fiscalYearEnding(row.donationDate);

  // The gift's OWN id (row.transactionId for the employee gift, `${row.transactionId}-match`
  // for the match gift) must be threaded in and written to the column, not closed over from
  // `row.transactionId` — otherwise both gifts would carry the SAME unsuffixed id in
  // `Benevity Transaction ID`, breaking the spec's per-gift idempotency guarantee (the match
  // gift's pre-create lookup in the consumer would never find a match, re-creating it on every
  // retry, while the employee-gift lookup would start returning two items).
  const baseColumns = (amount: number, transactionId: string): Record<string, unknown> => ({
    [cols.amount]: amount,
    [cols.date]: { date: row.donationDate },
    [cols.disbursementDate]: { date: disbursementPeriodEnding },
    // Fiscal Year Ending and Gift Type are TEXT columns on the Donations board (same as
    // funraise-sync and salesforce-import write them), so they take plain strings — a `{date}`
    // or `{label}` object here is what Monday rejects as "invalid value" for the column.
    [cols.fiscalYearEnding]: fyEnding,
    [cols.status]: { label: 'Received' },
    [cols.anonymousDonor]: { checked: personItemId ? 'false' : 'true' },
    [cols.transactionId]: transactionId,
    ...(personItemId ? { [cols.donor]: { item_ids: [Number(personItemId)] } } : {}),
  });

  const gifts: GiftSpec[] = [];

  if (row.totalDonationToBeAcknowledged > 0) {
    gifts.push({
      transactionId: row.transactionId,
      itemName: `${donorLabel} - Donation ${row.donationDate} (Benevity)`,
      columnValues: {
        ...baseColumns(row.totalDonationToBeAcknowledged, row.transactionId),
        [cols.giftType]: 'Donation',
      },
    });
  }

  if (row.matchAmount > 0) {
    gifts.push({
      transactionId: `${row.transactionId}-match`,
      itemName: `${row.company} - Employer Matching ${donorLabel} ${row.donationDate}`,
      columnValues: {
        ...baseColumns(row.matchAmount, `${row.transactionId}-match`),
        [cols.giftType]: 'Matching Donation',
        [cols.matchedBy]: { item_ids: [Number(organizationItemId)] },
      },
    });
  }

  return gifts;
}
