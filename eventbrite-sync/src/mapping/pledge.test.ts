import { describe, it, expect, vi } from 'vitest';
import { countyForZip, mapPledge } from './pledge';
import { testConfig, withPledge } from '../test/testConfig';
import type { EventbriteAnswer, EventbriteAttendee } from '../eventbrite/client';

const pledge = withPledge(testConfig()).pledge!;
const event = pledge.events['9100']!;
const zc = pledge.zipCounty;

function answer(questionId: string, value?: string): EventbriteAnswer {
  return { question_id: questionId, question: `Question ${questionId}`, type: 'text', ...(value === undefined ? {} : { answer: value }) };
}

function attendee(overrides: Partial<EventbriteAttendee> = {}): EventbriteAttendee {
  return {
    id: 'a1', created: '2026-05-01T03:00:00Z', cancelled: false, refunded: false,
    profile: { name: 'Pat Rider', email: 'pat@example.com' },
    answers: [answer('11', '95014')],
    ...overrides,
  };
}

const placeholder = { name: 'Info Requested Info Requested', email: 'Info Requested' };
const map = (a: EventbriteAttendee, buyer: { name?: string; email?: string } | null = null) => mapPledge(a, buyer, event, pledge);

describe('countyForZip', () => {
  it('finds Santa Clara', () => expect(countyForZip('95014', zc)).toBe('Santa Clara'));
  it('finds San Mateo for 94303', () => expect(countyForZip('94303', zc)).toBe('San Mateo'));
  it('is Outside for a well-formed zip on no list', () => expect(countyForZip('10001', zc)).toBe('Outside'));
  it('is Unknown for no zip', () => expect(countyForZip(null, zc)).toBe('Unknown'));
  it('is Unknown for a malformed zip', () => expect(countyForZip('n/a', zc)).toBe('Unknown'));
});

describe('mapPledge', () => {
  it('writes a complete pledge', () => {
    const m = map(attendee());
    expect(m.itemName).toBe('Pat Rider');
    expect(m.columnValues).toEqual({
      p_id: 'a1',
      p_year: '2026',
      p_status: 'Pledged',
      p_details: 'Complete',
      p_date: { date: '2026-04-30' },
      p_email: { email: 'pat@example.com', text: 'pat@example.com' },
      p_zip: '95014',
      p_county: 'Santa Clara',
    });
  });

  it('cuts zip+4 and trims', () => {
    const m = map(attendee({ answers: [answer('11', ' 95014-1234 ')] }));
    expect(m.columnValues.p_zip).toBe('95014');
    expect(m.columnValues.p_county).toBe('Santa Clara');
  });

  it('keeps a malformed zip as typed', () => {
    const m = map(attendee({ answers: [answer('11', 'abc')] }));
    expect(m.columnValues.p_zip).toBe('abc');
    expect(m.columnValues.p_county).toBe('Unknown');
  });

  it('is Unknown with no zip answer, and writes no Zip', () => {
    const m = map(attendee({ answers: [answer('11')] }));
    expect(m.columnValues).not.toHaveProperty('p_zip');
    expect(m.columnValues.p_county).toBe('Unknown');
  });

  it('maps a single choice', () => {
    expect(map(attendee({ answers: [answer('12', 'Multiple days/Varios días ')] })).columnValues.p_days).toBe('Multiple days');
  });

  it('sends a typed answer with no label to Other Answers, never to a label column', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = map(attendee({ answers: [{ question_id: '12', question: 'Days', type: 'text', answer: 'whatever I typed' }] }));
    expect(m.columnValues).not.toHaveProperty('p_days');
    expect(m.columnValues.p_other).toEqual({ text: 'Days: whatever I typed' });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps a mapped label for a typed answer', () => {
    const m = map(attendee({ answers: [{ question_id: '12', question: 'Days', type: 'text', answer: 'Multiple days/Varios días ' }] }));
    expect(m.columnValues.p_days).toBe('Multiple days');
  });

  it('splits multi-select only on the pipe, so a choice with slashes stays whole', () => {
    const m = map(attendee({ answers: [answer('14', 'Banner/Flyer/Poster/Letrero/folleto | Friend/ Amigos')] }));
    expect(m.columnValues.p_heard).toEqual({ labels: ['Flyer', 'Friend'] });
  });

  it('keeps a comma inside a choice whole', () => {
    const m = map(attendee({ answers: [{ ...answer('13', 'Fast, often | Slow'), type: 'multiple_choice' }] }));
    expect(m.columnValues.p_rider).toEqual({ labels: ['Fast, often', 'Slow'] });
  });

  it('writes an unmapped multiple-choice answer as it arrives, and warns without the answer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = map(attendee({ answers: [{ ...answer('12', ' Some days '), type: 'multiple_choice' }] }));
    expect(m.columnValues.p_days).toBe('Some days');
    const text = warn.mock.calls.flat().join(' ');
    expect(text).toContain('12');
    expect(text).not.toContain('Some days');
    warn.mockRestore();
  });

  it('ticks consent only from consentValues', () => {
    expect(map(attendee({ answers: [answer('16', 'Yes/Si')] })).columnValues.p_consent).toEqual({ checked: 'true' });
    expect(map(attendee({ answers: [answer('16', 'No')] })).columnValues).not.toHaveProperty('p_consent');
    expect(map(attendee({ answers: [answer('16')] })).columnValues).not.toHaveProperty('p_consent');
  });

  it('writes Who Asked', () => {
    expect(map(attendee({ answers: [answer('15', 'A neighbor')] })).columnValues.p_who).toBe('A neighbor');
  });

  it('sends an unmapped answered question to Other Answers', () => {
    const m = map(attendee({ answers: [{ question_id: '18', question: 'I see myself as', type: 'text', answer: 'cyclist' }] }));
    expect(m.columnValues.p_other).toEqual({ text: 'I see myself as: cyclist' });
  });

  it('leaves out an ignored question and an unanswered one', () => {
    const m = map(attendee({ answers: [answer('19', 'secret'), answer('18')] }));
    expect(m.columnValues).not.toHaveProperty('p_other');
  });

  it('uses the buyer for a placeholder', () => {
    const m = map(attendee({ profile: placeholder, answers: [answer('11'), answer('16')] }), { name: 'Sam Buyer', email: 'sam@example.com' });
    expect(m.itemName).toBe('Sam Buyer');
    expect(m.columnValues.p_email).toEqual({ email: 'sam@example.com', text: 'sam@example.com' });
    expect(m.columnValues.p_details).toBe('Buyer only');
    expect(m.columnValues.p_county).toBe('Unknown');
    expect(m.columnValues).not.toHaveProperty('p_consent');
    expect(m.columnValues).not.toHaveProperty('p_other');
  });

  it('writes a placeholder with no usable buyer', () => {
    const m = map(attendee({ profile: placeholder, answers: [] }), null);
    expect(m.itemName).toBe('Pledge a1');
    expect(m.columnValues).not.toHaveProperty('p_email');
    expect(m.columnValues.p_details).toBe('Buyer only');
  });

  it('writes a placeholder whose buyer is also a placeholder', () => {
    const m = map(attendee({ profile: placeholder, answers: [] }), placeholder);
    expect(m.itemName).toBe('Pledge a1');
    expect(m.columnValues).not.toHaveProperty('p_email');
  });

  it('is Canceled when cancelled or refunded', () => {
    expect(map(attendee({ cancelled: true })).columnValues.p_status).toBe('Canceled');
    expect(map(attendee({ refunded: true })).columnValues.p_status).toBe('Canceled');
  });

  it('collapses whitespace and cuts free text', () => {
    const long = `first\nsecond ${'x'.repeat(3000)}`;
    const who = map(attendee({ answers: [answer('15', long)] })).columnValues.p_who as string;
    expect(who.startsWith('first second ')).toBe(true);
    expect(who).toHaveLength(2000);
    const other = map(attendee({ answers: [answer('18', long)] })).columnValues.p_other as { text: string };
    expect(other.text).toHaveLength(2000);
  });

  it('cuts the item name to 255', () => {
    expect(map(attendee({ profile: { name: 'n'.repeat(300), email: 'pat@example.com' } })).itemName).toHaveLength(255);
  });
});
