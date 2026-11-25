import type { EventbriteAttendee } from '../eventbrite/client';

// "zip" or "zip code"/"zipcode" as a word, so "Do you use Zipcar?" is not a ZIP question, or Spanish
// "código postal" (a Spanish-language class's form says nothing in English).
const ZIP_QUESTION = /\bzip(\s?code)?\b|c[oó]digo\s+postal/i;
const ZIP = /^\d{5}(-\d{4})?$/;

/**
 * The attendee's home ZIP from their custom answers: the first text question asking for a ZIP
 * whose answer is a ZIP (or ZIP+4, reduced to 5 digits). Anything else, including text a person
 * typed into the field, is discarded.
 */
export function homeZipFromAnswers(answers: EventbriteAttendee['answers']): string | null {
  if (!Array.isArray(answers)) return null;
  for (const entry of answers) {
    if (typeof entry?.question !== 'string' || !ZIP_QUESTION.test(entry.question.normalize('NFC'))) continue;
    if (entry.type !== 'text' || typeof entry.answer !== 'string') continue;
    const value = entry.answer.trim();
    if (ZIP.test(value)) return value.slice(0, 5);
  }
  return null;
}
