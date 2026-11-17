import { WorkerEntrypoint } from 'cloudflare:workers';
import { configFor, type ImpactAttributionConfig } from '../config';
import { normalizeEmployerName } from '../employerName';
import type { Env } from '../types';
import { upsertAnswer } from './store';

// The RPC other Workers call to hand over an employer answer (spec "Handing it over"). A
// deterministic outcome returns `{ recorded: false, reason }`; only a transient failure (D1)
// throws, so the caller can retry. Logs carry ids and the result, never the answer or context.

export interface EmployerAnswerInput {
  source: 'eventbrite';
  sourceId: string;
  personItemId: string;
  answer: string;
  answeredAt: string; // YYYY-MM-DD
  context: string;
}

export type EmployerAnswerResult =
  | { recorded: true }
  | { recorded: false; reason: 'disabled' | 'invalid' | 'non-answer' | 'closed' };

const MAX_ANSWER_LENGTH = 200;

// A real calendar date, not only the YYYY-MM-DD shape: 2026-13-45 and 2026-02-30 are refused.
function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d;
}

function isValid(input: EmployerAnswerInput): boolean {
  return typeof input === 'object' && input !== null
    && input.source === 'eventbrite'
    && typeof input.sourceId === 'string' && input.sourceId.trim() !== ''
    && typeof input.personItemId === 'string' && /^\d+$/.test(input.personItemId)
    && typeof input.answer === 'string'
    && typeof input.answeredAt === 'string' && isCalendarDate(input.answeredAt)
    && typeof input.context === 'string';
}

function log(input: Partial<EmployerAnswerInput> | null | undefined, result: string): void {
  console.log(JSON.stringify({
    operation: 'recordEmployerAnswer', source: input?.source, sourceId: input?.sourceId, personItemId: input?.personItemId, result,
  }));
}

export async function handleRecord(
  env: Pick<Env, 'DB'>,
  config: ImpactAttributionConfig,
  input: EmployerAnswerInput,
  now: string,
): Promise<EmployerAnswerResult> {
  const settings = config.employerAnswers;
  if (!settings) {
    log(input, 'disabled');
    return { recorded: false, reason: 'disabled' };
  }
  if (!isValid(input)) {
    log(input, 'invalid');
    return { recorded: false, reason: 'invalid' };
  }
  const answer = input.answer.trim().slice(0, MAX_ANSWER_LENGTH).trim();
  const answerNormalized = normalizeEmployerName(answer);
  const ignored = settings.ignore.map(normalizeEmployerName);
  if (answerNormalized === '' || ignored.includes(answerNormalized)) {
    log(input, 'non-answer');
    return { recorded: false, reason: 'non-answer' };
  }
  const outcome = await upsertAnswer(env.DB, {
    source: input.source, sourceId: input.sourceId, personItemId: input.personItemId, answer, answerNormalized,
    answeredAt: input.answeredAt, context: input.context, receivedAt: now,
  });
  log(input, outcome);
  return outcome === 'closed' ? { recorded: false, reason: 'closed' } : { recorded: true };
}

export class EmployerAnswers extends WorkerEntrypoint<Env> {
  async recordEmployerAnswer(input: EmployerAnswerInput): Promise<EmployerAnswerResult> {
    return handleRecord(this.env, configFor(this.env), input, new Date().toISOString());
  }
}
