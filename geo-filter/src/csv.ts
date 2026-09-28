// CSV output for the matched contacts. Staff open this in Excel/Sheets, and names come straight
// off a Monday board anyone with board access (or a public form feeding it) can edit.

// A cell starting with one of these is treated as a formula by spreadsheet apps (CSV/formula
// injection, OWASP) — `=HYPERLINK(...)` in a name would run when the file is opened.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * One CSV cell. Text starting with a formula trigger gets a leading `'`, which spreadsheets
 * treat as "literal text" and hide. Numbers are written as-is: a negative longitude like
 * -121.9 is data, not a formula, and prefixing it would turn it into text.
 */
export function csvCell(value: string | number | null | undefined): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (typeof value === 'string' && FORMULA_TRIGGER.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
}
