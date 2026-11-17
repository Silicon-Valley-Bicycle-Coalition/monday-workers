import { describe, it, expect } from 'vitest';
import { employerAnswerFrom, EMPLOYER_QUESTION } from './employer';
import { testConfig, withPledge } from '../test/testConfig';
import type { EventbriteAttendee } from '../eventbrite/client';

const event = withPledge(testConfig()).pledge!.events['9100']!;

function attendee(question: string, answer: string | undefined, type = 'text', questionId = '500'): EventbriteAttendee {
  return {
    id: 'a1', created: '2026-05-01T03:00:00Z', cancelled: false, refunded: false,
    profile: { name: 'Pat Rider', email: 'pat@example.com' },
    answers: [{ question_id: questionId, question, type, ...(answer === undefined ? {} : { answer }) }],
  };
}

describe('employerAnswerFrom, by wording', () => {
  it.each(['Employer', 'Where do you work?', '¿Dónde trabajas?', 'Name of the company you work for', 'Company', ' Company: '])('matches "%s"', (question) => {
    expect(employerAnswerFrom(attendee(question, '  Acme Corp '), null)).toBe('Acme Corp');
  });

  it.each(['Do you use Zipcar?', 'Company name for invoice', 'Company or club', 'Bike to the Future company sponsors'])('does not match "%s"', (question) => {
    expect(employerAnswerFrom(attendee(question, 'Acme Corp'), null)).toBeNull();
    expect(EMPLOYER_QUESTION.test(question)).toBe(false);
  });

  it('ignores a multiple_choice question', () => {
    expect(employerAnswerFrom(attendee('Employer', 'Acme Corp', 'multiple_choice'), null)).toBeNull();
  });

  it('is null for a blank or missing answer', () => {
    expect(employerAnswerFrom(attendee('Employer', '   '), null)).toBeNull();
    expect(employerAnswerFrom(attendee('Employer', undefined), null)).toBeNull();
  });

  it('is null with no answers', () => {
    expect(employerAnswerFrom({ ...attendee('Employer', 'x'), answers: null }, null)).toBeNull();
  });

  it('takes the first non-blank answer', () => {
    const a = attendee('Employer', '');
    a.answers!.push({ question_id: '501', question: 'Where do you work?', type: 'text', answer: 'Beta LLC' });
    expect(employerAnswerFrom(a, null)).toBe('Beta LLC');
  });
});

describe('employerAnswerFrom, with a pledge event', () => {
  const mapped = { ...event, questions: { ...event.questions, '123': 'employer' as const } };

  it('uses the mapped question even when its wording does not match', () => {
    expect(employerAnswerFrom(attendee('Organization', ' Acme ', 'text', '123'), mapped)).toBe('Acme');
  });

  it('prefers the mapped question over a wording match', () => {
    const a = attendee('Employer', 'Wording Co', 'text', '999');
    a.answers!.push({ question_id: '123', question: 'Organization', type: 'text', answer: 'Mapped Co' });
    expect(employerAnswerFrom(a, mapped)).toBe('Mapped Co');
  });

  it('falls back to wording when the event maps no employer question', () => {
    expect(employerAnswerFrom(attendee('Employer', 'Acme', 'text', '999'), event)).toBe('Acme');
  });

  it('skips a question in the event\'s ignoreQuestions when falling back to wording', () => {
    const ignoring = { ...event, ignoreQuestions: ['999'] };
    expect(employerAnswerFrom(attendee('Employer', 'Ignored Co', 'text', '999'), ignoring)).toBeNull();
    const a = attendee('Employer', 'Ignored Co', 'text', '999');
    a.answers!.push({ question_id: '998', question: 'Where do you work?', type: 'text', answer: 'Read Co' });
    expect(employerAnswerFrom(a, ignoring)).toBe('Read Co');
  });

  it('does not fall back when the mapped question is blank', () => {
    const a = attendee('Employer', 'Wording Co', 'text', '999');
    a.answers!.push({ question_id: '123', question: 'Organization', type: 'text', answer: ' ' });
    expect(employerAnswerFrom(a, mapped)).toBeNull();
  });
});
