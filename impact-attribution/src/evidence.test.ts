import { describe, expect, it } from 'vitest';
import { evidenceComment } from './evidence';
import type { MatchRow } from './rule';
import type { AnswerRow } from './answers/store';

const m = (matchDate: string, amountCents: number | null): MatchRow => ({ donationItemId: matchDate, personItemId: 'p', orgItemId: 'o', matchDate, amountCents });

describe('evidenceComment', () => {
  it('lists the matches newest first with amounts', () => {
    expect(evidenceComment('Acme Corp', [m('2026-05-01', 50000), m('2025-11-01', 25000), m('2025-06-01', null)])).toBe(
      'Proposed from 3 matching gifts by Acme Corp:\n2026-05-01 $500.00\n2025-11-01 $250.00\n2025-06-01 (no amount)',
    );
  });

  it('shows at most 10 lines, then how many more', () => {
    const many = Array.from({ length: 12 }, (_, i) => m(`2020-01-${String(12 - i).padStart(2, '0')}`, 100));
    const lines = evidenceComment('Acme', many).split('\n');
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe('Proposed from 12 matching gifts by Acme:');
    expect(lines[10]).toBe('2020-01-03 $1.00');
    expect(lines[11]).toBe('and 2 more');
  });

  it('formats thousands', () => {
    expect(evidenceComment('Acme', [m('2026-01-01', 123456789)])).toContain('$1,234,567.89');
  });

  const a = (answer: string, answeredAt: string, context = 'Pledge to Ride 2027'): AnswerRow => ({
    source: 'eventbrite', sourceId: answeredAt + answer, personItemId: 'p', answer, answerNormalized: answer.toLowerCase(),
    answeredAt, context, state: 'pending', orgItemId: null, receivedAt: answeredAt,
  });

  it('describes answer-only evidence, one line per answer', () => {
    expect(evidenceComment('Google', [], [a('Google', '2027-01-20'), a('Alphabet', '2026-12-01')])).toBe(
      'Proposed from an Eventbrite answer: "Google" (Pledge to Ride 2027, 2027-01-20)\nProposed from an Eventbrite answer: "Alphabet" (Pledge to Ride 2027, 2026-12-01)',
    );
  });

  it('names a Funraise answer by its source', () => {
    const funraise: AnswerRow = { ...a('Acme', '2026-11-18', 'Funraise transaction 4321'), source: 'funraise' };
    expect(evidenceComment('Acme', [], [funraise])).toBe(
      'Proposed from the matching-gift company on a Funraise gift: "Acme" (Funraise transaction 4321, 2026-11-18)',
    );
  });

  it('names a Mailchimp profile answer by its source', () => {
    const mailchimp: AnswerRow = { ...a('Acme', '2026-11-20', 'Mailchimp profile'), source: 'mailchimp' };
    expect(evidenceComment('Acme', [], [mailchimp])).toBe(
      'Proposed from the Employer field on their Mailchimp profile: "Acme" (Mailchimp profile, 2026-11-20)',
    );
  });

  it('puts match lines before answer lines when mixed', () => {
    expect(evidenceComment('Acme', [m('2026-05-01', 50000)], [a('Acme', '2027-01-20')])).toBe(
      'Proposed from 1 matching gifts by Acme:\n2026-05-01 $500.00\nProposed from an Eventbrite answer: "Acme" (Pledge to Ride 2027, 2027-01-20)',
    );
  });

  it('shows at most 10 answer lines, then how many more', () => {
    const many = Array.from({ length: 12 }, (_, i) => a('Acme', `2027-01-${String(20 - i).padStart(2, '0')}`));
    const lines = evidenceComment('Acme', [], many).split('\n');
    expect(lines).toHaveLength(11);
    expect(lines[10]).toBe('and 2 more');
  });

  it('HTML-escapes the answer and context', () => {
    const out = evidenceComment('Acme', [], [a('<a href="x">Acme</a> & Co', '2027-01-20', '"Gala" <b>')]);
    expect(out).toBe('Proposed from an Eventbrite answer: "&lt;a href=&quot;x&quot;&gt;Acme&lt;/a&gt; &amp; Co" (&quot;Gala&quot; &lt;b&gt;, 2027-01-20)');
    expect(out).not.toContain('<');
  });

  it('says when the newer employer came from the person\'s own answer', () => {
    expect(evidenceComment('Microsoft', [m('2026-09-01', 1000)], [], { orgName: 'Google, LLC', latestEvidence: '2027-01-20', source: 'answer' })).toBe(
      'Proposed from 1 matching gifts by Microsoft:\n2026-09-01 $10.00\nProposed as Former: named Google, LLC as their employer since (latest 2027-01-20).',
    );
  });

  it('says why a Draft is Former when a newer employer superseded it', () => {
    expect(evidenceComment('Microsoft', [m('2026-03-27', 1000), m('2026-03-02', 500)], [], { orgName: 'Google, LLC', latestEvidence: '2026-09-11', source: 'matches' })).toBe(
      'Proposed from 2 matching gifts by Microsoft:\n2026-03-27 $10.00\n2026-03-02 $5.00\n' +
      'Proposed as Former: Google, LLC has matched since (latest 2026-09-11).',
    );
  });
});

