// CSV output for the review and validate sheets. Staff open these in Excel/Sheets, and names
// arrived through public forms (Funraise, Eventbrite), so any cell can carry attacker text.
// Same guard as geo-filter/src/csv.ts.

// A cell starting with one of these is treated as a formula by spreadsheet apps (CSV/formula
// injection, OWASP): `=HYPERLINK(...)` in a name would run when the file is opened.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * One RFC 4180 CSV cell. Text starting with a formula trigger gets a leading `'`, which
 * spreadsheets treat as "literal text" and hide. Numbers are written as-is: a negative amount is
 * data, not a formula, and prefixing it would turn it into text.
 *
 * @example csvCell('=1+1') // "'=1+1"
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (typeof value !== 'number' && FORMULA_TRIGGER.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV line (no terminator) from already-ordered cell values. */
export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}
