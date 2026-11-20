// Employer answers from Mailchimp profiles (GitHub #7): the optional Employer field a member fills
// in on their Mailchimp profile (the preference center) is handed to impact-attribution's
// EmployerAnswers RPC, which proposes a Draft affiliation for staff to confirm. Runs on the hourly
// consent cron, from the same member read, so it needs no audience webhook.
//
// The D1 ledger (store.ts) keeps one row per answer handed over, keyed on a hash of the member and
// the answer, so an unchanged answer is sent once and a changed one is sent again. Never runs on a
// failed member read. Logs carry source ids, item ids and counts only: never an address or an answer.
import { logSkip, runDisposition, type WriteMode } from '../flags';
import type { BatchSkipContext } from '../writeSwitch';
import type { EmployerAnswersConfig } from '../types';
import type { GraphQLRequest } from '../consent/sources';
import { memberId } from '../logSafe';
import type { EmployerAnswerStore } from './store';

export const ANSWER_SOURCE = 'mailchimp';
export const ANSWER_CONTEXT = 'Mailchimp profile';

// An address no single People item holds is looked up again a day later, not every hour.
export const RECHECK_UNMATCHED_MS = 24 * 3600_000;

// impact-attribution's EmployerAnswers RPC (impact-attribution/src/answers/entrypoint.ts), restated
// for this caller. `{ recorded: false }` is final except `disabled` (impact-attribution has no
// employerAnswers config yet), which leaves the answer for a later run.
export interface EmployerAnswerInput {
  source: typeof ANSWER_SOURCE;
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

export interface EmployerPeople {
  // The People items holding the address in any of settings.emailColumns.
  findItemIds(settings: EmployerAnswersConfig, email: string): Promise<string[]>;
}

export interface EmployerAnswersDeps {
  settings: EmployerAnswersConfig | null;
  // Null when the EMPLOYER_ANSWERS binding is missing: the hand-over is off.
  sink: EmployerAnswerSink | null;
  // The member read's address → Employer answer. Throws if the read failed.
  readAnswers: () => Promise<Map<string, string>>;
  people: EmployerPeople;
  store: EmployerAnswerStore;
  isOutage: (err: unknown) => boolean;
  // Stops at this time (ms), so the cron ends on its own terms.
  deadline: number;
  now?: () => number;
}

export interface EmployerAnswersSummary {
  outcome: 'disabled' | 'skipped' | 'read-failed' | 'impact-disabled' | 'done';
  mode: WriteMode;
  // Members with a non-blank answer.
  answers: number;
  // Answers not yet settled in the ledger.
  pending: number;
  recorded: number;
  // impact-attribution declined (invalid, non-answer, closed): final.
  refused: number;
  unmatched: number;
  ambiguous: number;
  failed: number;
  // Left for the next run: over the cap, past the deadline, or after an outage.
  deferred: number;
}

export function normalizeAnswer(answer: string): string {
  return answer.trim().replace(/\s+/g, ' ').toLowerCase();
}

// `<member hash>:<first 16 hex of SHA-256 of the normalized answer>`. impact-attribution logs the
// source id, so it must carry no text.
export async function answerSourceId(email: string, answer: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeAnswer(answer)));
  const hex = [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${memberId(email)}:${hex}`;
}

const errName = (err: unknown): string => (err instanceof Error ? err.name : 'UnknownError');

export async function runEmployerAnswers(gate: BatchSkipContext, deps: EmployerAnswersDeps): Promise<EmployerAnswersSummary> {
  const { settings, sink } = deps;
  const now = deps.now ?? Date.now;
  const summary: EmployerAnswersSummary = {
    outcome: 'done', mode: gate.mode, answers: 0, pending: 0, recorded: 0, refused: 0, unmatched: 0, ambiguous: 0, failed: 0, deferred: 0,
  };
  if (settings === null || sink === null) return { ...summary, outcome: 'disabled' };
  const disposition = runDisposition(gate.mode);
  if (disposition === 'skip') return { ...summary, outcome: 'skipped' };

  let answers: Map<string, string>;
  try {
    answers = await deps.readAnswers();
  } catch {
    // The consent run already logged and alerted on this read.
    return { ...summary, outcome: 'read-failed' };
  }

  const settled = await deps.store.settledIds(new Date(now() - RECHECK_UNMATCHED_MS).toISOString());
  const pending: { email: string; answer: string; sourceId: string }[] = [];
  for (const [email, raw] of answers) {
    const answer = raw.trim();
    if (answer === '') continue;
    summary.answers += 1;
    const sourceId = await answerSourceId(email, answer);
    if (!settled.has(sourceId)) pending.push({ email, answer, sourceId });
  }
  summary.pending = pending.length;
  const work = pending.slice(0, settings.maxAnswersPerRun);
  summary.deferred = pending.length - work.length;

  const ctx = { ...gate, deliveryId: 'employer-answers' };
  const answeredAt = new Date(now()).toISOString().slice(0, 10);
  for (let i = 0; i < work.length; i += 1) {
    if (now() >= deps.deadline) {
      summary.deferred += work.length - i;
      break;
    }
    const { email, answer, sourceId } = work[i]!;
    let ids: string[];
    try {
      ids = await deps.people.findItemIds(settings, email);
    } catch (err) {
      if (deps.isOutage(err)) {
        summary.deferred += work.length - i;
        break;
      }
      summary.failed += 1;
      console.error(JSON.stringify({ worker: 'mailchimp-sync', event: 'employer-answer-failed', environment: gate.environment, sourceId, step: 'people', error: errName(err) }));
      continue;
    }
    const at = new Date(now()).toISOString();
    if (ids.length !== 1) {
      const outcome = ids.length === 0 ? 'unmatched' : 'ambiguous';
      summary[outcome] += 1;
      if (disposition === 'run') await deps.store.record(sourceId, outcome, null, at);
      continue;
    }
    const personItemId = ids[0]!;
    if (disposition === 'dry-run') {
      logSkip(ctx, 'Employer answers', 'recordEmployerAnswer', [{ source: ANSWER_SOURCE, sourceId, personItemId }]);
      continue;
    }
    let result: EmployerAnswerResult;
    try {
      result = await sink.recordEmployerAnswer({ source: ANSWER_SOURCE, sourceId, personItemId, answer, answeredAt, context: ANSWER_CONTEXT });
    } catch (err) {
      // impact-attribution failed (D1, or not deployed with the entrypoint): every further call
      // would fail the same way, so leave the rest for the next hour.
      summary.failed += 1;
      summary.deferred += work.length - i - 1;
      console.error(JSON.stringify({ worker: 'mailchimp-sync', event: 'employer-answer-failed', environment: gate.environment, sourceId, step: 'impact-attribution', error: errName(err) }));
      break;
    }
    if (result.recorded) {
      await deps.store.record(sourceId, 'recorded', personItemId, at);
      summary.recorded += 1;
    } else if (result.reason === 'disabled') {
      summary.outcome = 'impact-disabled';
      summary.deferred += work.length - i;
      break;
    } else {
      await deps.store.record(sourceId, result.reason, personItemId, at);
      summary.refused += 1;
    }
  }

  console.log(JSON.stringify({
    worker: 'mailchimp-sync', event: 'employer-answers-run', environment: gate.environment,
    ...(disposition === 'dry-run' ? { dryRun: true } : {}), ...summary,
  }));
  return summary;
}

const FIND_QUERY = `query ($boardId: ID!, $columnId: String!, $email: [String]!) {
  items_page_by_column_values(board_id: $boardId, columns: [{ column_id: $columnId, column_values: $email }], limit: 2) {
    items { id }
  }
}`;

// Exact matches on each address column. Mailchimp addresses are lowercase, as People's are once
// salesforce-import or a Worker wrote them; a mixed-case staff entry reads as unmatched.
export function createEmployerPeople(request: GraphQLRequest): EmployerPeople {
  return {
    async findItemIds(settings, email) {
      const ids = new Set<string>();
      for (const columnId of settings.emailColumns) {
        const data = await request<{ items_page_by_column_values: { items: { id: string }[] } }>(
          FIND_QUERY, { boardId: settings.boardId, columnId, email: [email] },
        );
        for (const item of data.items_page_by_column_values.items) ids.add(item.id);
      }
      return [...ids];
    },
  };
}
