import type { MondayClient } from '../monday/client';
import type { RowStore, DonationRowRecord } from '../db/rows';
import type { DisbursementStore } from '../db/disbursements';
import type { AliasStore } from '../db/aliases';
import type { BenevityImportConfig } from '../types';
import type { ParsedRow } from '../parse/report';
import { resolveOrganization } from '../matching/organizations';
import { resolvePerson } from '../matching/people';
import { splitRowIntoGifts } from '../mapping/giftSplit';
import { createWorklistItem } from '../matching/worklist';
import { errorMessage } from '../util/errorMessage';

export interface BenevityQueueMessage {
  transactionId: string;
}

export interface QueueMessageLike<T> {
  body: T;
  ack(): void;
  retry(): void;
}

export interface ProcessBatchDeps {
  rowStore: RowStore;
  disbursementStore: DisbursementStore;
  aliasStore: AliasStore;
  mondayClient: MondayClient;
  config: BenevityImportConfig;
  now: () => string;
}

export async function processBenevityQueueBatch(
  messages: QueueMessageLike<BenevityQueueMessage>[],
  deps: ProcessBatchDeps
): Promise<void> {
  for (const message of messages) {
    const { transactionId } = message.body;
    try {
      await processOne(transactionId, deps);
      message.ack();
    } catch (err) {
      const errMsg = errorMessage(err);
      console.error(`benevity consumer: failed to process "${transactionId}": ${errMsg}`);
      // Left at 'ingested' (its only possible pre-write status here) so the queue's own
      // retry+DLQ handles it — this is an unexpected/transient failure, not a business
      // decision, so it must not read as 'needs-review' on the board.
      await deps.rowStore.updateStatus(transactionId, 'ingested', { error: errMsg });
      message.retry();
    }
  }
}

async function processOne(transactionId: string, deps: ProcessBatchDeps): Promise<void> {
  const row = await deps.rowStore.getRow(transactionId);
  if (row === null) {
    throw new Error(`benevity consumer: no row for transaction id "${transactionId}"`);
  }
  if (row.status === 'written') return; // redelivered message for already-completed work

  const parsed = JSON.parse(row.rawRow) as ParsedRow;

  if (parsed.currency !== 'USD') {
    await worklistAndMarkReview(deps, row, parsed, `currency "${parsed.currency}" is not USD`);
    return;
  }
  if (parsed.totalDonationToBeAcknowledged < 0 || parsed.matchAmount < 0) {
    await worklistAndMarkReview(deps, row, parsed, 'row has a negative amount');
    return;
  }

  const orgResult = await resolveOrganization(deps.mondayClient, deps.aliasStore, deps.config, parsed.company);
  if (orgResult.status === 'unresolved') {
    await worklistAndMarkReview(deps, row, parsed, orgResult.reason);
    return;
  }

  const personResult = await resolvePerson(
    deps.mondayClient,
    deps.config,
    {
      company: parsed.company,
      donorFirstName: parsed.donorFirstName,
      donorLastName: parsed.donorLastName,
      email: parsed.email,
    },
    orgResult.organizationItemId
  );
  if (personResult.status === 'unresolved') {
    await worklistAndMarkReview(deps, row, parsed, personResult.reason);
    return;
  }
  const personItemId = personResult.status === 'resolved' ? personResult.personItemId : null;

  const disbursement = await deps.disbursementStore.getDisbursement(row.disbursementId);
  if (disbursement === null) {
    throw new Error(`benevity consumer: no disbursement ${row.disbursementId} for transaction "${transactionId}"`);
  }

  const gifts = splitRowIntoGifts(
    {
      row: parsed,
      disbursementPeriodEnding: disbursement.periodEnding,
      organizationItemId: orgResult.organizationItemId,
      personItemId,
    },
    deps.config
  );

  const donationsBoardId = deps.config.monday.boards.donations;
  if (donationsBoardId === null) {
    throw new Error('config: monday.boards.donations is not configured');
  }
  const txnIdColumn = deps.config.benevityImport.donationsColumns.transactionId;

  let employeeItemId: string | undefined;
  let matchItemId: string | undefined;

  for (const gift of gifts) {
    const existing = await deps.mondayClient.findItemsByColumnValue(donationsBoardId, txnIdColumn, gift.transactionId);
    let itemId: string;
    if (existing.length > 0) {
      itemId = existing[0].id;
      await deps.mondayClient.changeColumnValues(donationsBoardId, itemId, gift.columnValues);
    } else {
      const created = await deps.mondayClient.createItem(donationsBoardId, gift.itemName, gift.columnValues);
      itemId = created.id;
    }
    if (gift.transactionId === transactionId) {
      employeeItemId = itemId;
    } else {
      matchItemId = itemId;
    }
  }

  await deps.rowStore.updateStatus(transactionId, 'written', {
    ...(employeeItemId ? { mondayEmployeeItemId: employeeItemId } : {}),
    ...(matchItemId ? { mondayMatchItemId: matchItemId } : {}),
    writtenAt: deps.now(),
  });
}

async function worklistAndMarkReview(
  deps: ProcessBatchDeps,
  row: DonationRowRecord,
  parsed: ParsedRow,
  reason: string
): Promise<void> {
  await createWorklistItem(deps.mondayClient, deps.config, {
    reason,
    name: `${parsed.donorFirstName} ${parsed.donorLastName}`.trim(),
    email: parsed.email,
    company: parsed.company,
    amount: parsed.totalDonationToBeAcknowledged + parsed.matchAmount,
    date: parsed.donationDate,
  });
  await deps.rowStore.updateStatus(row.transactionId, 'needs-review', { error: reason });
}
