import type { EventbriteAttendee } from '../eventbrite/client';
import type { PledgeEventConfig } from '../types';

// "Company name for invoice" is deliberately not matched: it is about billing, not who employs the attendee.
export const EMPLOYER_QUESTION = /employer|where do you work|company you work|empleador|d[oó]nde trabajas/i;

/**
 * The attendee's employer answer, trimmed, or null. A pledge event's question mapped to `employer`
 * wins; with none mapped, the first non-blank answer to a text question worded like one, skipping
 * a pledge event's `ignoreQuestions` (staff list a question there to mean "don't read it"). Never
 * logs the answer: it is whatever a person typed.
 */
export function employerAnswerFrom(attendee: EventbriteAttendee, pledgeEvent: PledgeEventConfig | null): string | null {
  const answers = Array.isArray(attendee.answers) ? attendee.answers : [];
  const mappedIds = pledgeEvent === null ? [] : Object.keys(pledgeEvent.questions).filter((id) => pledgeEvent.questions[id] === 'employer');
  if (mappedIds.length > 0) {
    for (const entry of answers) {
      if (typeof entry?.question_id === 'string' && mappedIds.includes(entry.question_id)) {
        const value = trimmed(entry.answer);
        if (value !== null) return value;
      }
    }
    return null;
  }
  const ignored = pledgeEvent?.ignoreQuestions ?? [];
  for (const entry of answers) {
    if (typeof entry?.question_id === 'string' && ignored.includes(entry.question_id)) continue;
    if (entry?.type !== 'text' || typeof entry.question !== 'string' || !EMPLOYER_QUESTION.test(entry.question)) continue;
    const value = trimmed(entry.answer);
    if (value !== null) return value;
  }
  return null;
}

function trimmed(answer: unknown): string | null {
  if (typeof answer !== 'string') return null;
  const value = answer.trim();
  return value === '' ? null : value;
}
