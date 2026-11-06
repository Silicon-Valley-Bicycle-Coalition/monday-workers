import { describe, it, expect } from 'vitest';
import { homeZipFromAnswers } from './homeZip';

const zip = (question: string, answer: unknown, type = 'text') => ({ question, question_id: '1', type, answer });

describe('homeZipFromAnswers', () => {
  it.each(['What is your home ZIP code?', 'Home Zip Code', 'Mailing Zip Code', 'Your zipcode'])('reads "%s"', (w) => {
    expect(homeZipFromAnswers([zip(w, '95112')])).toBe('95112');
  });

  it('does not read a word containing zip', () => {
    expect(homeZipFromAnswers([zip('Do you use Zipcar?', '95112')])).toBeNull();
  });

  it('ignores a non-text question', () => {
    expect(homeZipFromAnswers([zip('Zip code', '95112', 'dropdown')])).toBeNull();
  });

  it('trims and reduces ZIP+4', () => {
    expect(homeZipFromAnswers([zip('Zip', ' 95112-1234 ')])).toBe('95112');
  });

  it.each(['95112 please call me', 'Zip: 95112', '9511', '951123', 'ABCDE', '', 95112, null, undefined])('treats %s as no answer', (v) => {
    expect(homeZipFromAnswers([zip('Zip', v)])).toBeNull();
  });

  it('takes the first valid answer', () => {
    expect(homeZipFromAnswers([zip('Home Zip', 'unknown'), zip('Mailing Zip', '94301')])).toBe('94301');
  });

  it.each([undefined, null, []])('copes with answers %s', (a) => {
    expect(homeZipFromAnswers(a)).toBeNull();
  });

  it('skips entries with no question', () => {
    expect(homeZipFromAnswers([{ answer: '95112', type: 'text' }, { question: null, answer: '95112', type: 'text' }])).toBeNull();
  });
});
