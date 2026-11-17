import type { EventbriteAttendee } from '../eventbrite/client';
import { realEmail } from '../eventbrite/placeholder';
import { employerAnswerFrom } from '../mapping/employer';
import type { PledgeEventConfig } from '../types';
import type { ProcessBatchDeps } from './processBatch';

// The impact-attribution EmployerAnswers RPC (impact-attribution/src/answers/entrypoint.ts),
// restated structurally: the two Workers share no package. Spec: "Handing it over" in
// docs/superpowers/specs/2026-11-17-eventbrite-employer-answers-design.md.
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

export interface EmployerAnswerSink {
  recordEmployerAnswer(input: EmployerAnswerInput): Promise<EmployerAnswerResult>;
}

const MAX_ANSWER_LENGTH = 200;

/**
 * Hands the attendee's employer answer to impact-attribution, keyed to the People item their own
 * email already matches. Called after the board write and before the ledger row is marked
 * `written`, so a thrown (transient) failure retries the message, which adopts its existing item.
 * `{ recorded: false }` is final and only logged. Never creates a People item, and never logs the
 * answer, the context or the email.
 */
export async function recordEmployerAnswer(attendee: EventbriteAttendee, pledgeEvent: PledgeEventConfig | null, context: string, deps: ProcessBatchDeps): Promise<void> {
  const sink = deps.employerAnswers ?? null;
  const { config, mondayClient } = deps;
  // A missing binding (production until impact-attribution is deployed there) is the switch being off.
  if (sink === null || config.employerAnswers?.enabled !== true) return;
  if (attendee.cancelled === true || attendee.refunded === true) return;
  // Only the attendee's own email: a placeholder "Info Requested" has none (and no answers either).
  const email = realEmail(attendee.profile?.email);
  if (email === null) return;
  const answer = employerAnswerFrom(attendee, pledgeEvent);
  if (answer === null) return;

  const peopleBoardId = config.monday.boards['people-live'];
  if (peopleBoardId === null || peopleBoardId === undefined) {
    console.warn(`eventbrite-sync consumer: attendee ${attendee.id} employer answer not recorded: monday.boards["people-live"] is not configured`);
    return;
  }
  // findItemByColumnValue, never matchPerson: that creates a People item on a miss.
  const person = await mondayClient.findItemByColumnValue(peopleBoardId, config.attendeeSync.peopleEmailColumn, email);
  if (person === null) return;

  const result = await sink.recordEmployerAnswer({
    source: 'eventbrite',
    sourceId: attendee.id,
    personItemId: person.id,
    answer: answer.slice(0, MAX_ANSWER_LENGTH).trim(),
    answeredAt: answeredAtOf(attendee, new Date()),
    context,
  });
  if (!result.recorded) {
    console.warn(`eventbrite-sync consumer: attendee ${attendee.id} employer answer not recorded: ${result.reason}`);
  }
}

// The attendee's created date (UTC, as Eventbrite stamps it), or today's UTC date when it's missing
// or not a real calendar date: impact-attribution refuses anything else as invalid.
export function answeredAtOf(attendee: EventbriteAttendee, now: Date): string {
  const created = typeof attendee.created === 'string' ? attendee.created.slice(0, 10) : '';
  return isCalendarDate(created) ? created : now.toISOString().slice(0, 10);
}

function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// The staff-comment context: a pledge reads as its year's campaign, anything else as its event.
export function pledgeContext(pledgeEvent: PledgeEventConfig): string {
  return `Pledge to Ride ${pledgeEvent.year}`;
}
