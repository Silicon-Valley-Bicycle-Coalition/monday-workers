import type { FunraiseSubscription } from '../funraise/client';
import type { SubscriptionsPollConfig } from '../types';
import { toISODate } from '../util/isoDate';

export interface MappedSubscription {
  columnValues: Record<string, unknown>;
  // Vocabulary the config doesn't know (a new Funraise frequency or status). The column is left
  // unset and the row is still written; the caller logs these with the subscription id.
  warnings: string[];
}

const idString = (id: FunraiseSubscription['id']): string => String(id);

/**
 * Funraise subscription row → Recurring Gifts column values, in the shapes Monday requires
 * (spec 2026-09-18 "Field mapping"). Pure: the Donor connect column is not set here, the upsert
 * adds it after matching. A column configured as null is skipped.
 */
export function mapSubscriptionToColumns(row: FunraiseSubscription, poll: SubscriptionsPollConfig): MappedSubscription {
  const { columns, frequencyMultiplier, statusLabelMap, funraiseLinkBase } = poll;
  const columnValues: Record<string, unknown> = {};
  const warnings: string[] = [];
  const id = idString(row.id);

  if (columns.funraiseId) {
    columnValues[columns.funraiseId] = { url: `${funraiseLinkBase}${id}`, text: id };
  }

  const amount = typeof row.sourceAmount === 'number' && Number.isFinite(row.sourceAmount) ? row.sourceAmount : null;
  if (columns.installmentAmount && amount !== null) {
    columnValues[columns.installmentAmount] = amount;
  }

  const frequency = typeof row.frequency === 'string' ? row.frequency : null;
  const multiplier = frequency !== null ? frequencyMultiplier[frequency] : undefined;
  if (frequency !== null && multiplier === undefined) {
    warnings.push(`frequency "${frequency}" is not in subscriptionsPoll.frequencyMultiplier; Frequency and Annualized Value left unset`);
  }
  if (columns.frequency && frequency !== null && multiplier !== undefined) {
    columnValues[columns.frequency] = { label: frequency };
  }
  if (columns.annualizedValue && amount !== null && multiplier !== undefined) {
    columnValues[columns.annualizedValue] = amount * multiplier;
  }

  const status = typeof row.status === 'string' ? row.status : null;
  if (status !== null) {
    const label = statusLabelMap[status];
    if (label === undefined) {
      warnings.push(`status "${status}" is not in subscriptionsPoll.statusLabelMap; Status left unset`);
    } else if (columns.status) {
      columnValues[columns.status] = { label };
    }
  }

  if (columns.nextPayment) {
    // A cancelled subscription has no next payment; clear the cell rather than leave a stale date.
    const next = toISODate(row.nextPaymentDate);
    columnValues[columns.nextPayment] = next === null ? {} : { date: next };
  }

  if (columns.designation) {
    const formName = row.form?.name;
    if (typeof formName === 'string' && formName !== '') columnValues[columns.designation] = formName;
  }

  const companyName = row.companyMatch?.companyName;
  const hasMatch = typeof companyName === 'string' && companyName !== '';
  if (columns.companyMatch) {
    columnValues[columns.companyMatch] = hasMatch ? { checked: 'true' } : {};
  }
  if (columns.matchEmployer) {
    columnValues[columns.matchEmployer] = hasMatch ? companyName : '';
  }

  return { columnValues, warnings };
}

/** Funraise's own name for the subscription, or a readable fallback. */
export function subscriptionItemName(row: FunraiseSubscription): string {
  if (typeof row.name === 'string' && row.name !== '') return row.name;
  const supporterName = row.supporter && typeof row.supporter.name === 'string' ? row.supporter.name : null;
  if (supporterName) return row.frequency ? `${supporterName} - ${row.frequency}` : supporterName;
  return `Funraise subscription ${idString(row.id)}`;
}
