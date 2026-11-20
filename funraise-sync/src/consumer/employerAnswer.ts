import { getPath } from '../util/getPath';
import type { FunraiseSyncConfig } from '../types';

// The impact-attribution EmployerAnswers RPC (impact-attribution/src/answers/entrypoint.ts),
// restated structurally: the two Workers share no package. eventbrite-sync restates it the same
// way (src/consumer/employerAnswer.ts there). GitHub #6.
export interface EmployerAnswerInput {
  source: 'funraise';
  sourceId: string;
  personItemId: string;
  answer: string;
  answeredAt: string; // YYYY-MM-DD
  context: string;
}

export type EmployerAnswerResult =
  | { recorded: true }
  | { recorded: false; reason: 'disabled' | 'invalid' | 'non-answer' | 'closed' };

export interface EmployerAnswerSink {
  recordEmployerAnswer(input: EmployerAnswerInput): Promise<EmployerAnswerResult>;
}

// Funraise facts, not per-deployment choices: the company a donor picked in the form's
// matching-gift search, and the subscription an installment carries.
const COMPANY_NAME_FIELD = 'companyMatch.companyName';
const SUBSCRIPTION_ID_FIELD = 'subscription.id';
const MAX_ANSWER_LENGTH = 200;

export interface EmployerAnswerDeps {
  config: FunraiseSyncConfig;
  employerAnswers?: EmployerAnswerSink | null;
}

/**
 * Hands the matching-gift company on a one-time gift to impact-attribution as a proposed employer
 * for staff to confirm (impact-attribution skips it when the donor already has a Current
 * employer). Installments are left out: their company goes to Recurring Gifts → Match Employer.
 *
 * Best effort: the answer is worth having, never worth failing or delaying a donation for, so a
 * thrown RPC is logged and swallowed, like the Recurring Gift link. A redelivery sends it again,
 * which impact-attribution's upsert on (source, transaction id) absorbs. Never logs the company
 * name, the donor's email or name: ids and the result only.
 */
export async function recordEmployerAnswer(
  rawPayload: Record<string, unknown>,
  transactionId: string,
  personItemId: string,
  answeredAt: string | null,
  deps: EmployerAnswerDeps,
  now: Date = new Date()
): Promise<void> {
  const sink = deps.employerAnswers ?? null;
  // A missing binding is the switch being off, as is employerAnswers.enabled false.
  if (sink === null || deps.config.employerAnswers?.enabled !== true) return;
  if (getPath(rawPayload, SUBSCRIPTION_ID_FIELD) != null) return;
  const company = getPath(rawPayload, COMPANY_NAME_FIELD);
  if (typeof company !== 'string' || company.trim() === '') return;

  try {
    const result = await sink.recordEmployerAnswer({
      source: 'funraise',
      sourceId: transactionId,
      personItemId,
      answer: company.trim().slice(0, MAX_ANSWER_LENGTH).trim(),
      answeredAt: answeredAt ?? now.toISOString().slice(0, 10),
      context: `Funraise transaction ${transactionId}`,
    });
    if (!result.recorded) {
      console.warn(`funraise-sync consumer: transaction "${transactionId}" employer answer not recorded: ${result.reason}`);
    }
  } catch (err) {
    // The error class only: a message from the far side could quote what it was handed.
    const name = err instanceof Error ? err.name : typeof err;
    console.warn(`funraise-sync consumer: transaction "${transactionId}" employer answer not recorded: RPC failed (${name})`);
  }
}
