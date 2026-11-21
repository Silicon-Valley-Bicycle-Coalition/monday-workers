import { toE164 } from '../webhook/parse';

// An extension written after the number: "x123", "ext 123", "ext. 123", "extension 123", "#123",
// or a comma/semicolon dial pause. Everything from the marker on is dropped.
const EXTENSION = /\s*(?:[,;]|#|\bx\b|\bext\b\.?|\bextension\b|x(?=\d)).*$/i;

/**
 * A People Phone value as E.164, or null when it isn't a usable number. Monday stores the column
 * as staff typed it, so this tolerates formatting and drops an extension before reading the number
 * the same way ingest reads Zoom's (toE164: US default for a bare 10- or 11-digit number).
 */
export function normalizePeoplePhone(value: string | null | undefined, region: string): string | null {
  if (value === null || value === undefined) return null;
  const withoutExtension = value.replace(EXTENSION, '').trim();
  return toE164(withoutExtension, region);
}
