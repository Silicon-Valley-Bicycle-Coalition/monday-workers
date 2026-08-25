// The one parser for Monday amount-column display text ("$1,200.00", "1200", "US$1 200") —
// letters and pledges both build on this so a format fix lands once. Strips everything except
// digits, dot, and minus rather than assuming one currency format. Returns null for text with
// no digits at all (so "pending" or "" never silently becomes 0) and for garbage that still
// fails to parse as a single number (e.g. "12.34.56") — callers choose their own fallback.
export function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[^0-9.-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
